#!/usr/bin/env python3
"""Переносит юридические документы из Word на сайт дословно: текст не меняется, меняется только вёрстка.

Запуск (нужен только Python, без сторонних библиотек):
    python deploy/legal_build.py <папка с .docx> <имя миграции без .sql>

Создаёт legal/terms.html, legal/privacy.html, legal/additional-data.html и миграцию, которая
сохраняет точный текст версии в таблице legal_versions (её и подтверждают пользователи).
Для новой редакции: поправить VERSION ниже, запустить скрипт с новым именем миграции.
"""
import hashlib
import html
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
VERSION = '1.2'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# код документа → (часть имени файла, адрес на сайте)
DOCS = {'terms': ('_1_', 'terms.html'), 'privacy': ('_2_', 'privacy.html'), 'additional': ('_3_', 'additional-data.html')}

PAGE = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} — SPEED HELPER</title>
<style>
:root{{color-scheme:dark}}
body{{margin:0;background:#0b0c0e;color:#e8ebef;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}}
main{{max-width:720px;margin:0 auto;padding:24px 18px 64px}}
h1{{font-size:24px;line-height:1.25;margin:8px 0;text-align:center}}h2{{font-size:18px;line-height:1.3;margin:28px 0 8px;color:#39ff6a}}
p,li{{color:#c9cfd6}}p{{margin:10px 0}}ul{{padding-left:20px}}li{{margin:4px 0}}
.ctr{{text-align:center}}.brand{{color:#39ff6a;font-weight:700;margin-bottom:0}}.note{{color:#8b939e;font-size:14px;border-left:3px solid #2a2f36;padding-left:12px;margin-top:24px}}
.meta{{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}}.meta div{{flex:1 1 140px;background:#191c20;border-radius:12px;padding:10px 12px;color:#c9cfd6;font-size:14px}}.meta b{{display:block;color:#8b939e;font-weight:500;font-size:12px}}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>
"""


def text_of(p):
    out = []
    for el in p.iter():
        if el.tag == W + 't':
            out.append(el.text or '')
        elif el.tag == W + 'tab':
            out.append(' ')
        elif el.tag == W + 'br':
            out.append('\n')
    return ''.join(out)


def style_of(p):
    ppr = p.find(W + 'pPr')
    s = ppr.find(W + 'pStyle') if ppr is not None else None
    return s.get(W + 'val') if s is not None else None


def centered(p):
    ppr = p.find(W + 'pPr')
    j = ppr.find(W + 'jc') if ppr is not None else None
    return j is not None and j.get(W + 'val') == 'center'


def convert(path):
    """Возвращает (заголовок, html-блоки, точный текст документа)."""
    with zipfile.ZipFile(path) as z:
        body = ET.fromstring(z.read('word/document.xml')).find(W + 'body')
    blocks, plain, title, items = [], [], '', []

    def flush():
        if items:
            blocks.append('<ul>' + ''.join(f'<li>{html.escape(i)}</li>' for i in items) + '</ul>')
            items.clear()

    for el in body:
        if el.tag == W + 'tbl':
            flush()
            cells = []
            for tc in el.iter(W + 'tc'):
                lines = [ln for p in tc.iter(W + 'p') for ln in text_of(p).split('\n') if ln.strip()]
                plain.extend(lines)
                cells.append(f'<div><b>{html.escape(lines[0])}</b>{html.escape(" ".join(lines[1:]))}</div>')
            blocks.append('<div class="meta">' + ''.join(cells) + '</div>')
        elif el.tag == W + 'p':
            t = text_of(el).strip()
            if not t:
                continue
            plain.append(t)
            st, esc = style_of(el), html.escape(t)
            if st == 'ListBullet':
                items.append(t)
                continue
            flush()
            if st == 'Title':
                title = title or t
                blocks.append(f'<h1>{esc}</h1>')
            elif st == 'Heading1':
                blocks.append(f'<h2>{esc}</h2>')
            elif st == 'SHNote':
                blocks.append(f'<p class="note">{esc}</p>')
            elif centered(el):
                blocks.append(f'<p class="ctr{" brand" if t == "SPEED HELPER" else ""}">{esc}</p>')
            else:
                blocks.append(f'<p>{esc}</p>')
    flush()
    return title, blocks, '\n'.join(plain)


def main(src, migration):
    sql = ["""-- Юридические документы: точный текст каждой версии, которую подтверждают пользователи.
-- Текст нельзя изменить задним числом: новая редакция добавляется новой строкой (см. deploy/legal_build.py).
create table if not exists legal_versions (
  doc text not null check (doc in ('terms', 'privacy', 'additional')), version text not null,
  title text not null, body text not null, sha256 text not null,
  published_at timestamptz not null default now(),
  primary key (doc, version));
alter table legal_versions enable row level security;
revoke all on legal_versions from anon, authenticated;
create or replace function _legal_versions_frozen() returns trigger language plpgsql as $$
begin raise exception 'Текст опубликованной версии документа менять нельзя'; end $$;
drop trigger if exists legal_versions_frozen on legal_versions;
create trigger legal_versions_frozen before update or delete on legal_versions for each row execute function _legal_versions_frozen();
"""]
    files = os.listdir(src)
    for doc, (part, out) in DOCS.items():
        name = next(f for f in files if part in f and f.lower().endswith('.docx'))
        title, blocks, plain = convert(os.path.join(src, name))
        if '$doc$' in plain:
            raise SystemExit('В тексте документа встретился разделитель $doc$')
        with open(os.path.join(ROOT, 'legal', out), 'w', encoding='utf-8', newline='\n') as f:
            f.write(PAGE.format(title=html.escape(title), body='\n'.join(blocks)))
        digest = hashlib.sha256(plain.encode('utf-8')).hexdigest()
        sql.append(f"insert into legal_versions(doc, version, title, body, sha256) values ('{doc}', '{VERSION}', $doc${title}$doc$,\n$doc${plain}$doc$,\n'{digest}');\n")
        print(f'{doc}: {title!r}, {len(plain)} символов, sha256 {digest[:12]}…')
    with open(os.path.join(ROOT, 'supabase', 'migrations', migration + '.sql'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(sql))


if __name__ == '__main__':
    if len(sys.argv) != 3 or not re.fullmatch(r'\d{3}_[a-z0-9_]+', sys.argv[2]):
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
