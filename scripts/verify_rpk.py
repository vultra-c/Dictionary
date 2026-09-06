"""Check the actual archive, embedded dictionary, identity and signed container."""
import json
from pathlib import Path
import zipfile

packages = list(Path('dist').glob('*.rpk'))
assert packages, 'No RPK produced'
for path in packages:
    raw = path.read_bytes()
    assert len(raw) <= 7_000_000, 'RPK exceeds 7 MB: ' + str(len(raw))
    assert b'RPK Sig Block 42' in raw, 'Missing RPK signature block'
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['package'] == 'com.vultrac.dictionary'
        meta_path = next(n for n in names if n.endswith('common/dict/meta.json'))
        meta = json.loads(archive.read(meta_path))
        assert any(n.endswith('common/dict/d-0.json') for n in names)
    print(json.dumps({'rpk': str(path), 'bytes': len(raw), 'dictionary': meta}, ensure_ascii=False))
