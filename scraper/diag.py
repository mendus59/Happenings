# One-off diagnostic (not merged): what's in the LCB On Premise licensee spreadsheet?
import re, urllib.request, io, openpyxl
UA = {'User-Agent': 'Happenings/1.0 (+https://github.com/mendus59/Happenings)'}
html = urllib.request.urlopen(urllib.request.Request('https://lcb.wa.gov/records/frequently-requested-lists', headers=UA), timeout=60).read().decode('utf8', 'replace')
links = sorted(set(re.findall(r'href="([^"]+\.xlsx?)"', html)))
for l in links: print('LINK', l)
on = [l for l in links if re.search(r'On%20Premise|On Premise|OnPremise', l, re.I)]
print('ONPREM', on)
url = on[0] if on[0].startswith('http') else 'https://lcb.wa.gov' + on[0]
data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
print('BYTES', len(data))
wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
for ws in wb.worksheets:
    print('SHEET', ws.title, ws.max_row, ws.max_column)
    rows = ws.iter_rows(values_only=True)
    for i, r in enumerate(rows):
        s = ' | '.join('' if v is None else str(v) for v in r)
        if i < 6 or re.search(r'MOONBEEM|LUND', s, re.I) or (re.search(r'PORT ORCHARD', s, re.I) and re.search(r'PENDING', s, re.I)):
            print('ROW', i, s[:400])
