"""Удаление фона у фото товаров (очередь product_images.processing_status = 'pending').

Запускается GitHub Actions по расписанию. Нужны переменные окружения:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Алгоритм: нейросеть ISNet выделяет все объекты переднего плана, SAM — вещь в центре кадра
(соседние вещи на стойке отбрасываются); результат кладётся на фон магазина в формате 4:5.
Оригинал не удаляется: в админке можно вернуть его одной кнопкой.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter, ImageOps
from rembg import new_session, remove

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BATCH = int(os.environ.get("PHOTO_BATCH", "40"))
BG_COLOR = (236, 235, 231)  # цвет «concrete» из дизайна магазина
CANVAS = (1200, 1500)
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def http(method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(f"{URL}{path}", data=body, method=method, headers={**HEADERS, **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def rest(method: str, path: str, payload=None, prefer: str | None = None):
    h = {"Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    data = http(method, f"/rest/v1/{path}", json.dumps(payload).encode() if payload is not None else None, h)
    return json.loads(data) if data else None


def claim_batch() -> list[dict]:
    # Зависшие более 30 минут задачи возвращаются в очередь
    stale = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 1800))
    rest("PATCH", f"product_images?processing_status=eq.processing&processing_started_at=lt.{stale}", {"processing_status": "pending"})
    rows = rest("GET", f"product_images?select=id,product_id,original_storage_path,storage_path&processing_status=eq.pending&order=created_at.asc&limit={BATCH}")
    claimed = []
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for r in rows:
        # Оптимистичная блокировка: берём, только если статус всё ещё pending
        res = rest("PATCH", f"product_images?id=eq.{r['id']}&processing_status=eq.pending",
                   {"processing_status": "processing", "processing_started_at": now}, prefer="return=representation")
        if res:
            claimed.append(r)
    return claimed


def is_collage(im: Image.Image) -> bool:
    """Коллаж из нескольких фото: однотонные полосы-разделители в средней части кадра."""
    g = np.asarray(im.convert("L"), dtype=np.int16)
    h, w = g.shape

    def has_line(arr: np.ndarray, lo: int, hi: int) -> bool:
        for i in range(lo, hi):
            line = arr[i]
            if line.std() < 4 and (line.mean() > 225 or line.mean() < 30):
                return True
        return False

    rows = has_line(g, int(h * 0.3), int(h * 0.7))
    cols = has_line(g.T, int(w * 0.3), int(w * 0.7))
    return rows or cols


def touches_edges(mask: np.ndarray) -> bool:
    """Крупный план: вещь обрезана краями кадра с нескольких сторон."""
    m = mask > 127
    sides = [m[0].mean(), m[-1].mean(), m[:, 0].mean(), m[:, -1].mean()]
    return sum(v > 0.25 for v in sides) >= 2


def segment(im: Image.Image, isnet, sam) -> np.ndarray | None:
    if is_collage(im):
        return None
    w, h = im.size
    m_all = np.array(remove(im, session=isnet, only_mask=True))
    pts = [[w * 0.5, h * 0.5], [w * 0.42, h * 0.62], [w * 0.58, h * 0.62]]
    m_center = np.array(remove(im, session=sam, only_mask=True,
                               sam_prompt=[{"type": "point", "data": [int(x), int(y)], "label": 1} for x, y in pts]))
    b = (m_center > 127).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(b)
    if n <= 1:
        return None
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    b = (lab == big).astype(np.uint8)
    contours, _ = cv2.findContours(b, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = np.zeros_like(b)
    cv2.drawContours(hull, [cv2.convexHull(np.vstack(contours))], -1, 1, -1)
    # Внутри контура вещи доверяем общей маске (капюшон, вешалка внутри), снаружи — только вещи в центре
    mask = np.maximum(b * 255, np.where(hull > 0, m_all, 0)).astype(np.uint8)
    share = (mask > 127).mean()
    # Слишком мелко/крупно (коллаж деталей, фото крупным планом) — оставляем оригинал
    if share < 0.08 or share > 0.75 or touches_edges(mask):
        return None
    return mask


def compose(im: Image.Image, mask: np.ndarray) -> bytes:
    rgba = im.copy()
    rgba.putalpha(Image.fromarray(mask))
    cut = rgba.crop(rgba.getbbox())
    W, H = CANVAS
    s = min(W * 0.86 / cut.width, H * 0.88 / cut.height)
    cut = cut.resize((max(1, int(cut.width * s)), max(1, int(cut.height * s))), Image.LANCZOS)
    bg = Image.new("RGB", CANVAS, BG_COLOR)
    shadow = cut.split()[3].point(lambda a: 55 if a > 128 else 0).filter(ImageFilter.GaussianBlur(18))
    x, y = (W - cut.width) // 2, (H - cut.height) // 2
    bg.paste((200, 198, 192), (x + 10, y + 16), shadow)
    bg.paste(cut, (x, y), cut)
    out = io.BytesIO()
    bg.save(out, "JPEG", quality=88, optimize=True, progressive=True)
    return out.getvalue()


def load_models():
    # Без арены памяти onnxruntime: иначе SAM накапливает гигабайты между фото
    def opts():
        o = ort.SessionOptions()
        o.enable_cpu_mem_arena = False
        o.enable_mem_pattern = False
        return o
    return new_session("isnet-general-use", sess_opts=opts()), new_session("sam", sess_opts=opts())


def main() -> int:
    batch = claim_batch()
    if not batch:
        print("Очередь пуста")
        return 0
    print(f"В работе: {len(batch)} фото")
    isnet, sam = load_models()
    ok = skipped = failed = 0
    for row in batch:
        src = row.get("original_storage_path") or row["storage_path"]
        try:
            raw = http("GET", f"/storage/v1/object/product-images/{urllib.parse.quote(src)}")
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
            if max(im.size) > 1600:
                im.thumbnail((1600, 1600))
            mask = segment(im, isnet, sam)
            if mask is None:
                rest("PATCH", f"product_images?id=eq.{row['id']}", {"processing_status": "skipped", "processed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                skipped += 1
                continue
            data = compose(im, mask)
            dest = f"{row['product_id']}/proc-{uuid.uuid4()}.jpg"
            http("POST", f"/storage/v1/object/product-images/{urllib.parse.quote(dest)}", data,
                 {"Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000", "x-upsert": "false"})
            rest("PATCH", f"product_images?id=eq.{row['id']}", {
                "storage_path": dest, "processed_storage_path": dest, "processing_status": "done",
                "processing_error": None, "processed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            ok += 1
        except Exception as e:  # noqa: BLE001 — фиксируем ошибку и идём дальше
            failed += 1
            rest("PATCH", f"product_images?id=eq.{row['id']}", {"processing_status": "failed", "processing_error": str(e)[:300]})
            print(f"Ошибка {row['id']}: {e}", file=sys.stderr)
    print(f"Готово: обработано {ok}, оставлен оригинал {skipped}, ошибок {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
