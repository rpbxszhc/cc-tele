#!/usr/bin/env python3
import io
import json
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont


THEMES = {
    "light": {
        "bg": (248, 246, 255),
        "fg": (22, 22, 24),
        "muted": (92, 86, 108),
        "border": (156, 126, 220),
    },
    "dark": {
        "bg": (23, 25, 32),
        "fg": (236, 238, 244),
        "muted": (166, 173, 190),
        "border": (132, 112, 255),
    },
}


def fc_match(pattern):
    try:
        output = subprocess.check_output(
            ["fc-match", "-f", "%{file}\n%{index}\n", pattern],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).splitlines()
    except Exception:
        return None, 0
    if not output or not output[0]:
        return None, 0
    try:
        index = int(output[1]) if len(output) > 1 and output[1] else 0
    except ValueError:
        index = 0
    return output[0], index


def load_font_for_patterns(size, candidates):
    for candidate in candidates:
        path, index = fc_match(candidate)
        if not path:
            continue
        try:
            return ImageFont.truetype(path, size, index=index), path
        except Exception:
            continue
    return None, None


def load_fonts(size):
    primary, primary_path = load_font_for_patterns(size, [
        "monospace:lang=zh-cn",
        "Noto Sans Mono CJK SC",
        "Noto Sans Mono",
        "DejaVu Sans Mono",
        "monospace",
    ])
    symbol, _symbol_path = load_font_for_patterns(size, [
        "monospace:charset=276f",
        "Noto Sans Symbols 2",
        "Adwaita Mono",
        "DejaVu Sans Mono",
    ])
    if primary is None:
        primary = ImageFont.load_default()
        primary_path = "default"
    return primary, symbol or primary, primary_path


def char_width(char):
    code = ord(char)
    if code >= 0x1100 and (
        code <= 0x115F
        or code == 0x2329
        or code == 0x232A
        or (0x2E80 <= code <= 0xA4CF and code != 0x303F)
        or 0xAC00 <= code <= 0xD7A3
        or 0xF900 <= code <= 0xFAFF
        or 0xFE10 <= code <= 0xFE19
        or 0xFE30 <= code <= 0xFE6F
        or 0xFF00 <= code <= 0xFF60
        or 0xFFE0 <= code <= 0xFFE6
        or 0x20000 <= code <= 0x3FFFD
    ):
        return 2
    return 1


def is_symbol(char):
    code = ord(char)
    return 0x2600 <= code <= 0x27BF


def draw_terminal_line(draw, xy, line, primary_font, symbol_font, fill, cell_width):
    x, y = xy
    for char in line:
        font = symbol_font if is_symbol(char) else primary_font
        draw.text((x, y), char, font=font, fill=fill)
        x += cell_width * char_width(char)


def terminal_line_width(line, cell_width):
    return sum(char_width(char) for char in line) * cell_width


def text_size(draw, text, font):
    if not text:
        text = " "
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def main():
    payload = json.load(sys.stdin)
    text = str(payload.get("text") or "(no output yet)")
    theme_name = str(payload.get("theme") or "light")
    font_size = int(payload.get("fontSize") or 20)
    theme = THEMES.get(theme_name, THEMES["light"])
    font, symbol_font, _font_path = load_fonts(font_size)

    lines = text.splitlines() or ["(no output yet)"]
    probe = Image.new("RGB", (1, 1))
    draw = ImageDraw.Draw(probe)
    line_height = max(
        text_size(draw, "Ag|国", font)[1],
        text_size(draw, "❯", symbol_font)[1],
    ) + 8
    cell_width = max(text_size(draw, "M", font)[0], 1)
    padding_x = 24
    padding_y = 22
    max_line_width = max(terminal_line_width(line or " ", cell_width) for line in lines)
    width = max(360, padding_x * 2 + max_line_width + 8)
    height = max(120, padding_y * 2 + line_height * len(lines))
    width = min(width, 2400)
    height = min(height, 6000)

    image = Image.new("RGB", (width, height), theme["bg"])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (6, 6, width - 7, height - 7),
        radius=14,
        outline=theme["border"],
        width=3,
    )

    y = padding_y
    for line in lines:
        if y > height - padding_y:
            break
        draw_terminal_line(draw, (padding_x, y), line, font, symbol_font, theme["fg"], cell_width)
        y += line_height

    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    sys.stdout.buffer.write(output.getvalue())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
