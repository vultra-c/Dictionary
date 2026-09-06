#!/usr/bin/env python3
"""CI-only offline dictionary compiler. No NLP runtime dependency on the device."""

import argparse
import csv
import hashlib
from importlib.metadata import distribution
import io
import json
import os
from pathlib import Path
import re
import urllib.request
import zipfile
from collections import defaultdict


MAX_FILE = 32768
PAGE_SIZE = 24
WORD = re.compile(r"^[a-z]+(?:[-'][a-z]+)*$")
HAN = re.compile(r"[\u3400-\u9fff]")
REQUIRED = {"apple", "apply", "go", "good", "act", "action", "read", "readable"}
LABELS = {"p": "过去式", "d": "过去分词", "i": "现在分词", "3": "第三人称单数",
          "r": "比较级", "t": "最高级", "s": "复数", "0": "原形", "v": "变化形式", "D": "派生词"}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def download(url, expected, blob=False):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    digest = (hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
              if blob else hashlib.sha256(data).hexdigest())
    if digest != expected:
        raise ValueError("Source hash mismatch: " + url)
    return data


def rank(row):
    def number(key, fallback=10000000):
        try:
            return int(row.get(key) or 0) or fallback
        except ValueError:
            return fallback
    tags = set(row.get("tag", "").split())
    return (0 if row.get("oxford") == "1" else 1,
            0 if tags & {"zk", "gk", "cet4", "cet6"} else 1,
            min(number("frq"), number("bnc")), -number("collins", 0), row["word"])


def wordnet_edges(data):
    synsets, pointers = {}, []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name, pos in (("noun", "n"), ("verb", "v"), ("adj", "a"), ("adv", "r")):
            for line in archive.read("wordnet/data." + name).decode("utf-8").splitlines():
                if not line or not line[0].isdigit():
                    continue
                fields = line.split("|", 1)[0].split()
                count = int(fields[3], 16)
                words = [re.sub(r"\((?:a|p|ip)\)$", "", fields[4 + 2 * i]).lower()
                         for i in range(count)]
                key = (pos, fields[0])
                synsets[key] = words
                start = 4 + 2 * count
                for i in range(int(fields[start])):
                    symbol, offset, target_pos, indices = fields[start + 1 + i * 4:start + 5 + i * 4]
                    if symbol == "+":
                        pointers.append((key, ("a" if target_pos == "s" else target_pos, offset),
                                         int(indices[:2], 16), int(indices[2:], 16)))
        license_text = archive.read("wordnet/LICENSE").decode("utf-8")
    edges = set()
    for source, target, a, b in pointers:
        if a and b:
            left, right = synsets[source][a - 1], synsets[target][b - 1]
            if left != right and WORD.fullmatch(left) and WORD.fullmatch(right):
                edges.add(tuple(sorted((left, right))))
    return edges, license_text


def exchange(row):
    parts = {}
    for item in row.get("exchange", "").split("/"):
        key, separator, value = item.partition(":")
        if separator:
            parts[key] = value.lower()
    for key, value in parts.items():
        if key in LABELS and key not in {"D", "v"}:
            for word in value.split(","):
                if WORD.fullmatch(word) and word != row["word"]:
                    yield key, word, parts.get("1", "v")


def build(output, count, max_words, max_bytes):
    from pypinyin import Style, pinyin

    sources = json.loads(Path(__file__).with_name("dictionary_sources.json").read_text())
    package = distribution("pypinyin")
    if package.version != sources["pinyin"]["version"]:
        raise ValueError("Install the pinned dictionary-requirements.txt dependency")
    license_files = [file for file in package.files or [] if file.name.lower().startswith("license")]
    if not license_files:
        raise ValueError("pypinyin distribution is missing its license")
    pinyin_license = "\n".join(package.locate_file(file).read_text(encoding="utf-8") for file in license_files)
    ec, wn = sources["ecdict"], sources["wordnet"]
    raw = download(ec["url"], ec["git_blob_sha1"], True)
    ec_license = download(ec["license_url"], ec["license_git_blob_sha1"], True).decode("utf-8")
    rows = {}
    for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        row["word"] = row["word"].strip().lower()
        if WORD.fullmatch(row["word"]) and HAN.search(row.get("translation", "")):
            if row["word"] not in rows or rank(row) < rank(rows[row["word"]]):
                rows[row["word"]] = row
    missing = REQUIRED - rows.keys()
    if missing:
        raise ValueError("Missing required source words: " + repr(missing))
    selected = set(sorted(rows, key=lambda word: rank(rows[word]))[:count]) | REQUIRED
    wn_raw = download(wn["url"], wn["sha256"])
    edges, wn_license = wordnet_edges(wn_raw)
    for mapping in sources["reviewed_derivations"]:
        left, right = mapping["words"]
        selected.update((left, right))
        edges.add(tuple(sorted((left, right))))
    neighbors = {word for a, b in edges if a in selected or b in selected for word in (a, b)
                 if word in rows and word not in selected}
    # Reserve space for lemma closure; all retained derivational edges are bidirectional.
    selected.update(sorted(neighbors, key=lambda word: rank(rows[word]))[:max(0, max_words - len(selected) - 1000)])
    pending = list(selected)
    while pending:
        word = pending.pop()
        for code, other, _ in exchange(rows[word]):
            if code == "0" and other in rows and other not in selected:
                selected.add(other)
                pending.append(other)
    if not 50000 <= len(selected) <= max_words:
        raise ValueError("Selected word count outside budget: " + str(len(selected)))
    words = sorted(selected)
    ids = {word: i for i, word in enumerate(words)}
    relations = defaultdict(set)
    english = defaultdict(set)
    for word in words:
        source_id = ids[word]
        english[word].add(source_id)
        for code, other, reverse_code in exchange(rows[word]):
            if code == "0":
                if other in ids:
                    relations[source_id].add((ids[other], "0"))
                    relations[ids[other]].add((source_id, reverse_code if reverse_code in LABELS else "v"))
                    english[word].add(ids[other])
            else:
                target = ids.get(other, str(source_id) + "~" + other + "~" + code)
                relations[source_id].add((target, code))
                if other in ids:
                    relations[ids[other]].add((source_id, "0"))
                english[other].add(source_id)
    for left, right in sorted(edges):
        if left in ids and right in ids:
            relations[ids[left]].add((ids[right], "D"))
            relations[ids[right]].add((ids[left], "D"))
            english[left].add(ids[right])
            english[right].add(ids[left])
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("Output directory must be empty (avoid stale dictionary shards)")
    total_bytes, file_count = 0, 0

    def write(name, value):
        nonlocal total_bytes, file_count
        content = encoded(value)
        if len(content) > MAX_FILE:
            raise ValueError("Shard exceeds 32 KiB: " + name)
        (output / (name + ".json")).write_bytes(content)
        total_bytes += len(content)
        file_count += 1

    records, chinese = [], defaultdict(list)
    for i, word in enumerate(words):
        translation = rows[word]["translation"].replace("\\n", "\n").strip()[:240]
        records.append([word, rows[word].get("phonetic", ""), translation,
                        sorted(relations[i], key=lambda item: (str(item[0]), item[1]))])
        for char in sorted(set(HAN.findall(translation))):
            chinese[char].append(i)
    for start in range(0, len(records), PAGE_SIZE):
        write("d-" + str(start // PAGE_SIZE), records[start:start + PAGE_SIZE])

    def index(kind, groups):
        for bucket, values in groups.items():
            values.sort(key=lambda item: (item[0], item[1]))
            manifest, chunk, size = [], [], 2

            def flush():
                nonlocal chunk, size
                if chunk:
                    name = kind + "-" + str(bucket) + "-" + str(len(manifest))
                    write(name, chunk)
                    manifest.append([chunk[0][0], chunk[-1][0], name])
                    chunk, size = [], 2

            for value in values:
                length = len(encoded(value)) + 1
                if size + length > MAX_FILE - 128:
                    flush()
                chunk.append(value)
                size += length
            flush()
            write(kind + "-" + str(bucket), manifest)

    groups = {letter: [] for letter in "abcdefghijklmnopqrstuvwxyz"}
    for word, targets in english.items():
        groups[word[0]].extend([word, target] for target in sorted(targets))
    index("e", groups)
    groups = {bucket: [] for bucket in range(256)}
    for char, targets in chinese.items():
        groups[ord(char) % 256].extend([char, target] for target in targets)
    index("c", groups)
    syllables = defaultdict(set)
    for char in sorted(chinese):
        for syllable in pinyin(char, style=Style.NORMAL, heteronym=True, strict=False)[0]:
            syllable = syllable.lower().replace("ü", "v")
            if not re.fullmatch("[a-z]+", syllable):
                raise ValueError("Unmapped dictionary character: " + char)
            syllables[syllable].add(char)
    groups = {bucket: [] for bucket in range(32)}
    for syllable, chars in sorted(syllables.items()):
        groups[sum(map(ord, syllable)) % 32].extend([syllable, char] for char in sorted(chars))
    index("p", groups)
    write("licenses", {"sources": sources, "ecdict": ec_license, "wordnet": wn_license, "pypinyin": pinyin_license,
                       "verified_sha256": {"ecdict": hashlib.sha256(raw).hexdigest(),
                                           "wordnet": hashlib.sha256(wn_raw).hexdigest()}})
    write("meta", {"version": 1, "count": len(words), "pageSize": PAGE_SIZE,
                   "labels": LABELS, "maxFileBytes": MAX_FILE})
    if total_bytes > max_bytes:
        raise ValueError("Dictionary raw byte budget exceeded: " + str(total_bytes))
    print(json.dumps({"words": len(words), "files": file_count, "raw_bytes": total_bytes,
                      "max_file_bytes": MAX_FILE, "runtime_path": "/common/dict/*.json"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("src/common/dict"))
    parser.add_argument("--check-rpk", type=Path, help="Only check the CI-built RPK size; do not generate data")
    parser.add_argument("--count", type=int, default=50000)
    parser.add_argument("--max-words", type=int, default=55000)
    parser.add_argument("--max-bytes", type=int, default=40000000,
                        help="Uncompressed JSON budget; CI must separately enforce the 7,000,000-byte RPK limit")
    args = parser.parse_args()
    if os.environ.get("CI", "").lower() not in {"1", "true"}:
        parser.error("Dictionary generation is only permitted in CI")
    if args.check_rpk:
        size = args.check_rpk.stat().st_size
        if not args.check_rpk.is_file() or not 0 < size <= 7000000:
            parser.error("RPK must be a nonempty file no larger than 7,000,000 bytes: " + str(size))
        print(json.dumps({"rpk": str(args.check_rpk), "bytes": size, "max_bytes": 7000000}))
        return
    if not 50000 <= args.count <= args.max_words <= 55000:
        parser.error("Require 50000 <= count <= max-words <= 55000")
    build(args.output, args.count, args.max_words, args.max_bytes)


if __name__ == "__main__":
    main()
