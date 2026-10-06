#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
jp-learn 的日文 OCR 工作进程（由 server.js 以管道方式调用）。

────────────────────────────────────────────────────────────────────────
这个脚本**故意做得很薄**
────────────────────────────────────────────────────────────────────────
它只负责两件事：
  ① 调用 rapidocr + 官方日文模型，拿到「文本 + 边界框」
  ② 从图片自身算一些客观度量（宽高、行列投影峰值），作为版面判断的**证据**

它**不做**版面重建（分列、排序、注音过滤）。为什么：
  那些是纯几何算法，放在 JS 里可以用**纯函数测试**逐条断言，
  不需要装 Python、不需要真图、毫秒级跑完。
  放在 Python 里就只能靠"跑一遍看结果"，出错很难定位。
  所以：**Python 出证据，JS 出结论。**

────────────────────────────────────────────────────────────────────────
为什么用 rapidocr 3.x + 日文 ONNX 模型（试错记录，别重走）
────────────────────────────────────────────────────────────────────────
① rapidocr_onnxruntime 1.4.4 只带**中文**模型 → 假名全丢（`猫が歩いた` → `猫步`）。
   注意这**不是竖排问题**：横排一样错。而且它不支持 lang 参数。
② paddlepaddle 3.x + paddleocr 推理必崩：
   `OneDnnContext does not have the input Filter [operator < fused_conv2d > error]`，
   enable_mkldnn=False 和 FLAGS_use_mkldnn=0 都拦不住。
③ ✅ rapidocr 3.9.2 + japan_PP-OCRv4_rec_mobile.onnx（ONNX Runtime）
   横排假名全对；竖排 '猫が歩いた' 全对；注音被识别成独立小块（便于几何过滤）。

用法:
  python ocr-worker.py --probe
  python ocr-worker.py --image <path> [--lang japan] [--word-box] [--debug]
输出:
  一行 JSON（stdout 只输出这一行，日志一律走 stderr）
"""
import sys
import os
import io
import json
import argparse

# stdout 必须是纯 UTF-8：server.js 按 utf8 解码，且只读最后一行 JSON。
# 不能有任何别的东西写进 stdout（包括库的进度条、warning）。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', newline='')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# 模型目录钉在工作区内（用户要求：项目文件都留在工作区）
MODEL_DIR = os.path.join(ROOT, 'runtime', 'ocr', 'models')
PY_EXE = os.path.join(ROOT, 'runtime', 'ocr', 'py', 'python.exe')


def emit(obj):
    """把结果写进 stdout，一行 JSON。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write('\n')
    sys.stdout.flush()


def fail(code, message, **extra):
    emit({'ok': False, 'error': code, 'message': message, **extra})
    sys.exit(2)


# ─────────────────────────── 参数 ───────────────────────────
ap = argparse.ArgumentParser(add_help=False)
ap.add_argument('--image')
ap.add_argument('--lang', default='japan')
ap.add_argument('--probe', action='store_true')
ap.add_argument('--word-box', action='store_true')
ap.add_argument('--debug', action='store_true')
# 允许 --det-lang / --rec-lang 覆盖（将来加别的语言时用得上）
ap.add_argument('--rec-lang', default=None)
# 竖排优先开关：auto（默认，靠几何判断）/ vertical（强制转 90° 再识别）/ horizontal
ap.add_argument('--vertical', default='auto')
args, _unknown = ap.parse_known_args()


# ─────────────────────────── 依赖自检 ───────────────────────────
def load_rapidocr():
    try:
        from rapidocr import RapidOCR  # noqa
        from rapidocr.utils.typings import (  # noqa
            LangRec, LangDet, OCRVersion, ModelType,
        )
    except Exception as e:
        fail('NO_RUNTIME',
             '没有找到 OCR 运行时，请先在项目目录里执行 '
             '`node tools/get-ocr-runtime.mjs` 安装。',
             detail=f'{type(e).__name__}: {e}',
             python=sys.executable,
             expected=PY_EXE)
    return RapidOCR, LangRec, LangDet, OCRVersion, ModelType


# ─────────────────────────── --probe ───────────────────────────
if args.probe:
    RapidOCR, LangRec, LangDet, OCRVersion, ModelType = load_rapidocr()
    models = {}
    for name in ('ch_PP-OCRv4_det_mobile.onnx',
                 'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
                 'japan_PP-OCRv4_rec_mobile.onnx'):
        p = os.path.join(MODEL_DIR, name)
        models[name] = {'exists': os.path.exists(p),
                        'bytes': os.path.getsize(p) if os.path.exists(p) else 0}
    langs = sorted({e.value for e in LangRec})
    emit({
        'ok': True,
        'python': sys.version.split()[0],
        'rapidocr': True,
        'modelDir': MODEL_DIR,
        'modelDirExists': os.path.isdir(MODEL_DIR),
        'models': models,
        'allModelsPresent': all(m['exists'] for m in models.values()),
        # 说明：识别语言里**有** japan 才算真的能认日文
        'recLangs': langs,
        'hasJapan': 'japan' in langs,
    })
    sys.exit(0)


# ─────────────────────────── 主流程 ───────────────────────────
if not args.image:
    fail('NO_IMAGE', '没有指定要识别的图片（--image）。')
if not os.path.exists(args.image):
    fail('IMAGE_NOT_FOUND', '找不到要识别的图片。', path=args.image)

RapidOCR, LangRec, LangDet, OCRVersion, ModelType = load_rapidocr()

rec_lang_name = args.rec_lang or args.lang
try:
    rec_lang = LangRec(rec_lang_name)
except ValueError:
    fail('UNSUPPORTED_LANG',
         f'这个 OCR 运行时没有 {rec_lang_name!r} 语言模型。',
         supported=sorted({e.value for e in LangRec}))

try:
    import numpy as np
    from PIL import Image
except Exception as e:
    fail('NO_RUNTIME', '缺少 numpy/Pillow，请重跑 `node tools/get-ocr-runtime.mjs`。',
         detail=f'{type(e).__name__}: {e}')

# 日志走 stderr，避免污染 stdout 的 JSON
log_level = 'debug' if args.debug else 'error'
try:
    ocr = RapidOCR(params={
        'Global.model_root_dir': MODEL_DIR,
        'Global.log_level': log_level,
        'Global.return_word_box': bool(args.word_box),
        # 日文识别模型（关键）。检测/方向分类用中文模型即可 ——
        # 多语言检测模型对日文版面同样有效，实测竖排也能正确切列。
        'Rec.lang_type': rec_lang,
        'Rec.ocr_version': OCRVersion.PPOCRV4,
        'Rec.model_type': ModelType.MOBILE,
        'Det.lang_type': LangDet.CH,
        'Det.ocr_version': OCRVersion.PPOCRV4,
        'Det.model_type': ModelType.MOBILE,
        'EngineConfig.onnxruntime.use_cuda': False,
    })
except Exception as e:
    fail('INIT_FAILED', 'OCR 引擎启动失败，可能在下载模型时断网了。',
         detail=f'{type(e).__name__}: {e}')

# ── 读图并记录原图尺寸（版面判断要用真实像素坐标）──
try:
    im = Image.open(args.image)
    im.load()
except Exception as e:
    fail('IMAGE_UNREADABLE', '这张图片读不出来（可能不是图片，或文件损坏）。',
         detail=f'{type(e).__name__}: {e}')

img_w, img_h = im.size
exif_angle = 0
try:
    # 手机拍的照片常带 EXIF 方向。rapidocr 内部会按原始像素处理，
    # 这里只把 EXIF 角度报给 JS，由 JS 决定要不要提示用户。
    exif = im.getexif()
    exif_angle = int(exif.get(274, 0) or 0)
except Exception:
    exif_angle = 0

rgb = im.convert('RGB')
arr = np.array(rgb)

# ── 版面客观度量：投影带 ──
# 这是给 JS 的**证据**，不是结论。JS 用 rowBands/colBands 判断横排还是竖排。
#
# ⚠️ 这里的判据换过两次，先把弯路记下来（它一点都不显然）：
#
#   第一版数"峰值个数"（墨迹从无到有的次数）：
#     横排 900x120 实测 rowPeaks=1 但 colPeaks=29 → **被判成竖排** ❌
#     原因：横排每个字之间都有竖直细缝，也被算成峰。
#
#   第二版加报"峰的平均宽度"：
#     横排 meanPeakW=13.24  竖排 15.17 → 几乎一样，区分不出来 ❌
#     原因：竖排的列也会被字与字之间的缝切成好几段。
#
#   第三版（现在报的 rowBands/colBands）= 在 12% 阈值下、**忽略小于 3px 的带**：
#     实测区分得很干净：
#       横排：水平带 1 条（就一行），垂直带 25 条（全是被字间隙切开的碎段）
#       竖排：水平带 8 条（每个字一段），垂直带 3 条（真正的那几列）
#     判据：垂直带少且水平带多 → 竖排；反之 → 横排。
def projection_metrics():
    empty = {'rowPeaks': 0, 'colPeaks': 0, 'rowBands': 0, 'colBands': 0,
             'inkRatio': 0.0, 'meanPeakW': 0.0, 'meanPeakH': 0.0,
             'maxPeakW': 0.0, 'maxPeakH': 0.0}
    try:
        gray = np.array(rgb.convert('L'))
        ink = (gray < 160).astype(np.float32)      # 非白像素
        if ink.sum() < 50:
            return empty

        rowsum = ink.sum(axis=1)   # 每行的墨量 → 横排的"行"在这里成带
        colsum = ink.sum(axis=0)   # 每列的墨量 → 竖排的"列"在这里成带

        def runs(v, frac, minlen):
            """返回宽度 >= minlen 的连续段列表。"""
            thr = max(float(v.max()) * frac, 1.0)
            on = v > thr
            out, run = [], 0
            for x in on:
                if x:
                    run += 1
                elif run:
                    if run >= minlen:
                        out.append(run)
                    run = 0
            if run >= minlen:
                out.append(run)
            return out

        # 带：12% 阈值、至少 3px 宽（3px 以下的多半是笔画噪声）
        rbands = runs(rowsum, 0.12, 3)
        cbands = runs(colsum, 0.12, 3)
        # 峰：12% 阈值、不看最小宽度（兼容旧字段，也用于诊断输出）
        rpeaks = runs(rowsum, 0.12, 1)
        cpeaks = runs(colsum, 0.12, 1)

        mean = lambda a: round(sum(a) / len(a), 2) if a else 0.0
        return {
            'rowBands': len(rbands), 'colBands': len(cbands),
            'rowPeaks': len(rpeaks), 'colPeaks': len(cpeaks),
            'meanPeakH': mean(rpeaks), 'maxPeakH': float(max(rpeaks)) if rpeaks else 0.0,
            'meanPeakW': mean(cpeaks), 'maxPeakW': float(max(cpeaks)) if cpeaks else 0.0,
            'inkRatio': round(float(ink.sum()) / ink.size, 4),
        }
    except Exception:
        return empty


proj = projection_metrics()
img_metrics = {'width': int(img_w), 'height': int(img_h),
               'exifOrientation': exif_angle, **proj}


# ─────────────────── 竖排：转成横排再识别 ───────────────────
# ⚠️ 这一段是**实测逼出来的**，不是理论推导。先把走过的弯路记下来。
#
# 【问题】竖排识别会**整段整段地读错**。用"像真书页"的竖排图实测（3 列、含标点）：
#     横排对照组的字错误率   0.0%
#     竖排原图的字错误率    84.6%   ← 大量漏字 + 不少认错
#   表现不是"某个字认错"，而是**成串地崩**：柱子会被切成好几块、
#   边缘的字被切掉（「わたし…」的「わ」整段不见）。
#
# 【为什么】检测模型 ch_PP-OCRv4_det 是按**横排**文字训练的。
#   竖排一列又高又窄，检测器会给出一堆贴得很死的窄框，
#   识别器拿到这种被切边的窄条就开始瞎猜。
#   关键证据：**同一句话排成横排时 0 错误**，说明模型本身没问题，
#   是"方向"不对 —— 它没见过竖着的一列字。
#
# 【试过但没用的】
#   · 加白边（0/8/16/30/60px）：时好时坏，不解决根本问题；
#   · 提高分辨率（1.0~2.5 倍）：错误率没改善；
#   · 把每列再切成单字框：切出来只剩几十像素宽，认得更差。
#
# 【有用的：整图转 90°】
#   把竖排图**顺时针转 90°**，原来的"从右到左的列"就变成"从上到下的行"——
#   阅读顺序不变（最右的列 → 最上面的行），而字在识别器眼里变正了。
#   实测同一张书页图：84.6% → 只剩 1~2 个字错。
#
# 【方向必须对，用角点验证过】
#   造一张四角不同颜色的"地标图"跑 rotate 看颜色跑去哪：
#     rotate(-90, expand=True)（顺时针）：原图 右上角 → (W-1, 0) 左上角
#   所以旋转图尺寸是 (H, W)，点映射是：
#     旋转图 (rx, ry)  ←  原图 (x, y) = (W-1-ry, rx)
#   反解：原图 x = W-1-ry, y = rx
#   ⚠️ 注意这里的 W 是**原图宽**。我第一次写反了，把旋转图的宽当成了 W，
#      结果所有框都横过来了（宽高互换），肉眼一看就不对。
def _looks_vertical(metrics, items, force=None):
    """判断这张图要不要走"转 90° 再识别"这条路。

    force: 'vertical' / 'horizontal' 时直接听用户的（界面上有手动开关）。

    ⚠️ 判据换过一次，把原因记下来。
    第一版看"检测出来的框是不是又高又窄"（高/宽 >= 1.3 的占比）。
    它对**整列被当成一个框**的情况很好用，但对**字距宽、每个字各自成框**的
    竖排图完全失灵：那种图里每个框都是 44x50 这种方方正正的，
    高窄占比接近 0 → 判定成横排 → 竖排那条路根本不启动
    （实测 v.png 就是这样，明明排成两列却按横排处理 ❌）。

    现在主要看**投影带**，因为它衡量的是"整张图的墨迹分布"，和"被切成几个框"无关：
      横排 → 若干行横向长条 → rowBands 少、colBands 多
      竖排 → 若干列纵向长条 → colBands 少、rowBands 多
    这个规律在稀疏、紧凑、带汉字、带标点的情况下都成立。
    """
    if force == 'vertical':
        return True, '用户手动指定了竖排'
    if force == 'horizontal':
        return False, '用户手动指定了横排'

    col_bands = metrics.get('colBands') or 0
    row_bands = metrics.get('rowBands') or 0

    # 证据一（主）：投影带。竖排的"列"少而"行段"多。
    if row_bands >= 2 and col_bands >= 1:
        if col_bands * 2 <= row_bands:
            return True, '投影分布像竖排（垂直带 %d 少、水平带 %d 多）' % (col_bands, row_bands)
        if row_bands * 2 <= col_bands:
            return False, '投影分布像横排（水平带 %d 少、垂直带 %d 多）' % (row_bands, col_bands)

    # 证据二（补）：投影带分不出来时，看框的形状。
    tall = 0
    solid = 0
    for it in items or []:
        w = float(it.get('w') or 0)
        h = float(it.get('h') or 0)
        if w < 2 or h < 2:
            continue
        solid += 1
        if h / w >= 1.3:
            tall += 1
    if solid >= 2 and tall / solid >= 0.6:
        return True, '检测到的文字块 %d/%d 是高窄形' % (tall, solid)

    return False, '按横排处理'


def _rotate_and_recognize(im_rgb, arr_shape):
    """把整图顺时针转 90° 再识别，返回 (txts, boxes, scores, 旋转信息)。

    返回的 boxes 已经**映射回原图坐标系**，所以下游（reconstruct）可以
    完全不管旋转这件事，照常按 x 从右到左排。
    """
    h0, w0 = arr_shape[0], arr_shape[1]

    # ── 要不要先缩一缩 ──
    #
    # ⚠️⚠️ 这里是本轮最反直觉的一个结论：**别裁**。
    #
    #   一开始我想"裁掉四周空白能转得更快、更准"，于是裁到墨迹外接矩形再加白边。
    #   结果**怎么调白边都不对**：白边小了每列两端的字被切掉，
    #   白边大了相邻两列粘成一坨被切碎。
    #   实测（书页竖排图，同一张，只改裁切方式）：
    #     裁墨迹框 + 各种白边（横向 15%~80%、纵向 5%~20% 全扫过）
    #        → 一列碎成好几块，错 35/39  ❌
    #     不裁、整图
    #        → "右から左へ | と読み進めます | …"  错 35/39 的**框序对了** ✅
    #   原因是**列与列之间的空白本身就是给检测器的信号**。
    #   把那片空白裁掉之后，3 列挤在一起，检测器就把它们当成一坨，一切割就碎。
    #   整图里那点留白，正是它分列的依据。
    #
    #   所以：只在**图片大到会拖慢检测**时才等比缩小，绝不按墨迹框裁剪。
    MAX_DIM = 4000
    scale = 1.0
    if max(w0, h0) > MAX_DIM:
        scale = MAX_DIM / float(max(w0, h0))
        im_rgb = im_rgb.resize((max(1, int(w0 * scale)), max(1, int(h0 * scale))))
        w0, h0 = im_rgb.size

    # ── 再补一圈白边 ──
    # ⚠️ 这圈白边**不能省**，而且它的作用和"裁掉空白"正好相反，很容易搞混：
    #   裁掉空白  → 列会粘在一起 → 更差 ❌
    #   补上白边  → 列两端有呼吸空间 → 更准 ✅
    # 原因：旋转 90° 之后，**原图的"高"变成识别器的"文字行进方向"**，
    # 也就是每列的**首尾两字**正好落在旋转图的左右边缘上。
    # 没有白边，边缘那两个字就贴着图像边界，检测器会把它切掉。
    # 实测（书页竖排图）：无白边错 3 字（「続」→「統」、「へ」→「ハ」），
    #                     白边 30 后 4 列全部读对。
    # 白边按短边的比例给，保证不同分辨率下都是"一个字左右"的量。
    pad = max(30, int(min(w0, h0) * 0.10))
    canvas = Image.new('RGB', (w0 + pad * 2, h0 + pad * 2), 'white')
    canvas.paste(im_rgb, (pad, pad))
    im_rgb = canvas
    w0, h0 = im_rgb.size

    # ── 只补这一圈，位置在**旋转之前**；不要在旋转之后再加 ──
    # ⚠️ 我试过"旋转之后再补一圈"。结果**更差**：错字率 6.4% → 13.5%。
    #   原因：旋转**前**补的这圈白边，转过去之后就已经落在"文字行进方向"的两端，
    #   也就是每列的首尾本来就有留白；再补一圈反而把留白撑得太宽，
    #   检测器开始把一整列切碎。
    #   结论：**一圈就够，位置在旋转之前。**
    cw, ch = im_rgb.size        # ⚠️ W 用这个（旋转前的图宽），不是旋转后的宽

    # 先记下**旋转前**的尺寸：下面算坐标要用到"旋转前的高"。
    # ⚠️ 这里必须是旋转前的尺寸，不能拿旋转后的宽来代替（我错过一次，见下）。
    pre_w, pre_h = im_rgb.size

    rot = im_rgb.rotate(-90, expand=True)     # 顺时针
    res = ocr(np.array(rot.convert('RGB')))
    rtxts = getattr(res, 'txts', None) or []
    rboxes = getattr(res, 'boxes', None)
    rscores = getattr(res, 'scores', None)

    out_t, out_b, out_s = [], [], []
    for i, t in enumerate(rtxts):
        rb = None
        if rboxes is not None and i < len(rboxes):
            try:
                b = np.array(rboxes[i]).reshape(-1, 2)
                # 把旋转图上的框映射回**旋转前**的坐标系。
                #
                # ⚠️⚠️ 这个公式我搞错过一次，而且错了之后**症状非常迷惑**：
                #     框的位置全都镜像到了另一侧。因为竖排的两列本来就长得像
                #     （都是一列竖字），所以"左列框拿了右列内容"这件事
                #     肉眼看不出来，表现为"文字整体错位、读起来乱七八糟"，
                #     会让人误以为是识别质量问题，去调白边、调分辨率，全是白费。
                #
                #     错误公式： x_orig = (W-1) - ry     ← 用的是**旋转后的宽**
                #     正确公式： x_orig = ry,  y_orig = (H-1) - rx   ← 用的是**旋转前的高**
                #     两者差一个镜像，恰好把所有框搬到对面那一列。
                #
                #   怎么定下来的：造一张每个像素都编码自己坐标的图，跑一遍
                #   rotate(-90, expand=True)，再去找坐标被搬到哪儿：
                #       原图 (0,0)     -> 旋转图 (H-1, 0)
                #       原图 (W-1,0)   -> 旋转图 (H-1, W-1)
                #       原图 (0,H-1)   -> 旋转图 (0, 0)
                #   由此得到 x' = H-1-y, y' = x；反解就是上面那两行。
                #   然后还要**验证一遍**：把映射出来的 x 和"原图里墨迹的横向分段"
                #   对照，看每个框是否落在它那一列的真实范围内。
                #   证据一致才算数 —— 光推公式不算。
                ox = b[:, 1]                  # x_orig = ry
                oy = (pre_h - 1) - b[:, 0]    # y_orig = (H-1) - rx
                rb = {'x': round(float(ox.min()) / scale, 1),
                      'y': round(float(oy.min()) / scale, 1),
                      'w': round(float(ox.max() - ox.min()) / scale, 1),
                      'h': round(float(oy.max() - oy.min()) / scale, 1)}
            except Exception:
                rb = None
        out_t.append(t)
        out_b.append(rb)
        out_s.append(float(rscores[i]) if rscores is not None and i < len(rscores) else None)
    # 注意坐标要除以 scale 才能回到**原始图片**的坐标系：
    # 大图会先被缩小再识别，映射出来的坐标是"缩小后的坐标系"。
    return out_t, out_b, out_s, {
        'inputSize': [cw - pad * 2, ch - pad * 2],
        'padded': [cw, ch],
        'rotated': [ch, cw],
        'pad': pad,
        'scale': round(scale, 3),
    }


# ── 推理 ──
try:
    result = ocr(arr)
except Exception as e:
    fail('OCR_FAILED', '识别过程出错（图片可能太大或损坏）。',
         detail=f'{type(e).__name__}: {str(e)[:400]}')

txts = getattr(result, 'txts', None) or []
boxes = getattr(result, 'boxes', None)
scores = getattr(result, 'scores', None)

# 先把第一遍的框整理出来（既用于判断方向，也是横排时的最终结果）
def _norm_box(b):
    try:
        a = np.array(b).reshape(-1, 2)
        xs, ys = a[:, 0], a[:, 1]
        return {'x': round(float(xs.min()), 1), 'y': round(float(ys.min()), 1),
                'w': round(float(xs.max() - xs.min()), 1),
                'h': round(float(ys.max() - ys.min()), 1)}
    except Exception:
        return None


first_items = []
for i, t in enumerate(txts):
    text = (t or '').strip()
    if not text:
        continue
    it = {'text': text,
          'score': round(float(scores[i]), 4) if scores is not None and i < len(scores) else None}
    if boxes is not None and i < len(boxes):
        nb = _norm_box(boxes[i])
        if nb:
            it.update(nb)
    first_items.append(it)

# ⚠️⚠️ 最终结果变量**先定下来**，竖排那条路只在成功时才覆盖它。
#
#   这里踩过一个很隐蔽的坑：我先写好了竖排分支（把结果放进 items），
#   但紧接着又写了一句 `items = first_items` 收尾，
#   于是**竖排的成果被当场覆盖**。症状是"改了但完全没效果"：
#   输出和改之前一模一样，而 worker 内部的调试日志明明打印出
#   4 个正确的列框。最后是把中间结果和最终输出并排打出来，
#   才发现两者根本不是同一个东西。
#
#   教训：**"改了没效果"时，先确认中间结果和最终输出是不是同一个变量**，
#   不要一味怀疑算法。所以现在改成"先给默认值、成功才覆盖"的写法，
#   从结构上让这类覆盖不可能再发生。
items = first_items
vertical_info = None

is_vert, vert_reason = _looks_vertical(img_metrics, first_items, force=args.vertical)
if is_vert:
    try:
        out = _rotate_and_recognize(rgb, arr.shape)
        if out is not None:
            _t, _b, _s, _info = out
            items2 = []
            for i, t in enumerate(_t):
                text = (t or '').strip()
                if not text:
                    continue
                it = {'text': text,
                      'score': round(_s[i], 4) if _s[i] is not None else None}
                if _b[i]:
                    it.update(_b[i])
                items2.append(it)
            if items2:
                items = items2          # ← 唯一一次覆盖，且只在有结果时
                vertical_info = {'applied': True, 'reason': vert_reason, **_info,
                                 'firstPassCount': len(first_items),
                                 'secondPassCount': len(items2)}
    except Exception as e:
        # 转 90° 这条路失败**不能让整张图失败** —— 退回第一遍的结果，照样能用
        vertical_info = {'applied': False, 'reason': vert_reason,
                         'error': f'{type(e).__name__}: {str(e)[:200]}'}

word_results = getattr(result, 'word_results', None)

# 逐字框（可选，比较慢）。用于"(字)注音"配对，但目前方案不依赖它。
# 保留这个出口，是因为将来若要精确对齐注音会用到。
chars = []
if args.word_box and word_results:
    try:
        for wr in word_results:
            for ch in (getattr(wr, 'char_boxes', None) or []):
                chars.append(ch)
    except Exception:
        chars = []

emit({
    'ok': True,
    'image': img_metrics,
    'engine': {'name': 'rapidocr', 'version': getattr(__import__('rapidocr'), '__version__', '3.x'),
               'recLang': rec_lang_name, 'detModel': 'ch_PP-OCRv4_det_mobile'},
    'count': len(items),
    'items': items,
    'charCount': len(chars),
    # 竖排那条路走了没有、为什么走、两遍各出了多少块 ——
    # 这是给排查用的证据，界面不用它。
    'vertical': vertical_info,
})
