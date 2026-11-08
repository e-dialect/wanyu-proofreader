"""数字声调 ↔ 上标声调的编解码，只作用于记音列。

印出的《莆仙方言大词典》把调值排成上标小数字（`qa⁵³³`、`qa¹³vi²¹`），CSV 导出
把它们压平成了普通数字（`qa533`）。本模块负责这一层格式的双向转换。

一条硬规矩：**一个音节位上的数字串，若无法读成该列的一个合法调值，就原样返回并
给出状态，绝不猜一个切分出来。** 一串 `4213` 可以读成 42+13 也可以读成 4+2+13，
差别在于中间丢掉的那个音节的字母——那是损坏，不是一道该由程序解的题（#114 §5 第
5 类、#189「信息不足时不得猜」）。所以本模块的输出永远是「要么完整转换，要么一字
不动」，不存在半转换的单元格。

合法调值集与列的对应关系来自 `data/tone_notation.json`（可审阅的规则文件），上标
字符集来自项目自己的键盘定义，两处都不写死在代码里。
"""
import json
import os
import re
import unicodedata
from collections import namedtuple

EXACT = "EXACT"
AMBIGUOUS = "AMBIGUOUS"
UNSUPPORTED = "UNSUPPORTED"
NO_TONE = "NO_TONE"
EMPTY = "EMPTY"

# 单元格级状态取其中最"坏"的一个；这个元组的顺序即严重程度。
_STATUS_ORDER = (EXACT, NO_TONE, AMBIGUOUS, UNSUPPORTED)

# `@NNNN` 是源库缺字登记的序号，不是 Unicode 码点，其数字绝不能当成声调。
# 下界取 2：仓库内 `detectors.py` 用 @十六进制{3,6}，未入仓的 `w2_parser.py` 用
# @十进制{2,6}，两者在这份语料上实测等价但定义不一致；对转换器而言多保护几个字符
# 零成本，少保护一个就会把登记号印成上标。
# 上界刻意不设限：`5`、`3` 本身也是十六进制字符，所以一旦登记号长过规范，就无法
# 判断它到哪里结束、后面的数字是不是声调。与其猜一个边界，不如整格拒绝。
PLACEHOLDER = re.compile(r"@[\da-fA-F]{2,}")
PLACEHOLDER_MAX_HEX = 6
DIGIT_RUN = re.compile(r"\d+")

_WORD_TO_DIGIT = {"ZERO": "0", "ONE": "1", "TWO": "2", "THREE": "3", "FOUR": "4",
                  "FIVE": "5", "SIX": "6", "SEVEN": "7", "EIGHT": "8", "NINE": "9"}
_MAX_SEGMENTATIONS = 4


def _named_superscripts():
    """Enumerate SUPERSCRIPT DIGIT-* by Unicode name rather than by a typed table.

    Both directions of the codec then share one source of truth, and a keyboard
    that later gains ⁹ needs no code change.
    """
    by_digit, to_digit = {}, {}
    candidates = list(range(0x00B0, 0x00BC)) + list(range(0x2070, 0x2095))
    for codepoint in candidates:
        char = chr(codepoint)
        name = unicodedata.name(char, "")
        if name.startswith("SUPERSCRIPT "):
            digit = _WORD_TO_DIGIT.get(name[len("SUPERSCRIPT "):])
            if digit:
                by_digit[digit] = char
                to_digit[char] = digit
    return by_digit, to_digit


ALL_SUPERSCRIPTS, _SUPERSCRIPT_TO_DIGIT = _named_superscripts()


def load_superscript_map(values):
    """Digits this project can actually type, keyed by ASCII digit.

    Anything not reachable from the enabled keyboards must not be emitted: the
    point of raising a tone is to match the printed page, and the keyboard is the
    repo's own statement of what a proofreader can enter.
    """
    available = {char for char in values if char in _SUPERSCRIPT_TO_DIGIT}
    return {digit: char for digit, char in sorted(ALL_SUPERSCRIPTS.items())
            if char in available}


def flatten(value):
    """上标数字 → ASCII 数字。比较键与往返校验用，不触碰其他任何字符。"""
    return "".join(_SUPERSCRIPT_TO_DIGIT.get(char, char) for char in value or "")


ToneRules = namedtuple("ToneRules", "scheme_id rule_version title annotation_system "
                                    "notation columns legal_by_column long_tones")

RULE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "data", "tone_notation.json")
SUPPORTED_ANNOTATION_SYSTEM = "tone_value"


class SchemeError(ValueError):
    """The selected scheme cannot be handled by a tone-value codec."""


def load_tone_rules(path, scheme_id):
    """Load one scheme out of the reviewable rule file, refusing a half-valid one.

    A scheme whose digits are tone *categories* (《文读字汇》's 1–7) is rejected
    rather than converted: a `qa²`'s 2 means 阳平 in one book while another book's
    `qa²`'s 2 means an 阳入 contour value, and no amount of string inspection tells those apart. #189
    forbids inferring which scheme a book uses, so the operator has to say it.
    """
    with open(path, "r", encoding="utf-8") as handle:
        doc = json.load(handle)
    schemes = doc.get("schemes") or {}
    if scheme_id not in schemes:
        raise SchemeError("unknown scheme %r; the rule file defines: %s"
                          % (scheme_id, ", ".join(sorted(schemes)) or "(none)"))
    body = schemes[scheme_id]
    annotation_system = body.get("annotation_system")
    if annotation_system != SUPPORTED_ANNOTATION_SYSTEM:
        raise SchemeError(
            "scheme %r annotates tone as %r, not %r: %s"
            % (scheme_id, annotation_system, SUPPORTED_ANNOTATION_SYSTEM,
               body.get("why_this_scheme_is_here", "see the rule file")))
    sets = {name: frozenset(values)
            for name, values in (body.get("tone_value_sets") or {}).items()}
    columns = body.get("column_tone_value_sets") or {}
    legal_by_column = {}
    for column, set_name in columns.items():
        if set_name not in sets:
            raise SchemeError("scheme %s: column %s names unknown set %r"
                              % (scheme_id, column, set_name))
        if not sets[set_name]:
            raise SchemeError("scheme %s: set %s is empty" % (scheme_id, set_name))
        legal_by_column[column] = sets[set_name]
    if not legal_by_column:
        raise SchemeError("scheme %s declares no columns" % scheme_id)
    return ToneRules(scheme_id=scheme_id,
                     rule_version=doc["rule_version"],
                     title=body.get("title", scheme_id),
                     annotation_system=annotation_system,
                     notation=body.get("notation", ""),
                     columns=tuple(columns),
                     legal_by_column=legal_by_column,
                     long_tones=frozenset(body.get("long_tones", ())))


Conversion = namedtuple("Conversion", "text status tones reason")


def segment_tone_run(run, legal, limit=_MAX_SEGMENTATIONS):
    """Every way to read `run` as a sequence of legal tone values, longest first.

    Returning at most `limit` is deliberate: a caller only needs the contour count
    and whether a second reading exists, and an unbounded search over a long digit
    run is a cost a batch job should not pay.
    """
    results = []
    widest = max(len(value) for value in legal)

    def walk(position, taken):
        if len(results) >= limit:
            return
        if position == len(run):
            if taken:
                results.append(tuple(taken))
            return
        for size in range(min(widest, len(run) - position), 0, -1):
            piece = run[position:position + size]
            if piece in legal:
                walk(position + size, taken + [piece])

    walk(0, [])
    return results


def convert_cell(value, legal, superscripts):
    """Raise this cell's tone digits to superscripts, or leave it untouched.

    `tones` is only populated for an EXACT result: reporting half-read tones as if
    they were certain is exactly the failure this module exists to avoid.
    """
    if not value:
        return Conversion(text=value, status=EMPTY, tones=(), reason="")

    # A digit run is either wholly inside a placeholder or wholly outside it: a
    # placeholder starts at `@`, which is not a digit, and its own run is maximal,
    # so no run can straddle the boundary. Checking the start offset is enough.
    protected = []
    for mark in PLACEHOLDER.finditer(value):
        if len(mark.group(0)) - 1 > PLACEHOLDER_MAX_HEX:
            # Longer than the spec allows: the tail cannot be told apart from a
            # tone digit, and `flatten()` round-trips either way, so verify()
            # would never see it. Refuse the cell instead of guessing a boundary.
            return Conversion(text=value, status=UNSUPPORTED, tones=(),
                              reason="placeholder_out_of_spec_length")
        protected.append((mark.start(), mark.end()))

    def inside_placeholder(position):
        return any(start <= position < end for start, end in protected)

    tones = []
    pieces = []
    cursor = 0
    status = EXACT
    reason = ""
    for match in DIGIT_RUN.finditer(value):
        if inside_placeholder(match.start()):
            continue
        run = match.group(0)
        if run in legal:
            # One syllable slot carries exactly one contour, so "the run is itself
            # a legal value" is the test — not "the run splits uniquely". `21`
            # splits as 2+1 as well, and requiring uniqueness would refuse every
            # ordinary cell in the corpus.
            missing = sorted(digit for digit in run if digit not in superscripts)
            if missing:
                return Conversion(text=value, status=UNSUPPORTED, tones=(),
                                  reason="superscript_untypeable:" + "".join(missing))
            tones.append(run)
            pieces.append(value[cursor:match.start()])
            pieces.append(_raise(run, superscripts))
            cursor = match.end()
            continue
        collisions = segment_tone_run(run, legal)
        if collisions:
            # The run holds two or more contours: the letters that separated those
            # syllables are gone, so the slot boundary is not recoverable here. How
            # many contours and whether they split uniquely is what a reviewer
            # needs; the search is capped, so say so instead of implying an
            # exhaustive count.
            detail = "tone_run_holds_%d_contours" % len(collisions[0])
            if len(collisions) > 1:
                detail += "_in_%s%d_ways" % ("at_least_"
                                             if len(collisions) >= _MAX_SEGMENTATIONS else "",
                                             len(collisions))
            status = _worst(status, AMBIGUOUS)
            reason = detail
        else:
            status = _worst(status, UNSUPPORTED)
            reason = "tone_run_not_a_legal_value"

    if status != EXACT:
        return Conversion(text=value, status=status, tones=(), reason=reason)
    if not tones:
        return Conversion(text=value, status=NO_TONE, tones=(), reason="")
    pieces.append(value[cursor:])
    return Conversion(text="".join(pieces), status=EXACT, tones=tuple(tones), reason="")


def _worst(first, second):
    return first if _STATUS_ORDER.index(first) >= _STATUS_ORDER.index(second) else second


def _raise(run, superscripts):
    return "".join(superscripts[digit] for digit in run)


def validate_product_legal(values):
    """Explicit contours: 0 or 1–6 ASCII digits 1–5, at most 64; no inference."""
    if isinstance(values, (str, bytes)):
        raise SchemeError("declare a collection of legal tone values")
    values = list(values)
    if not values or len(values) > 64:
        raise SchemeError("declare between 1 and 64 legal tone values")
    for value in values:
        if (not isinstance(value, str) or not value or len(value) > 6
                or (value != "0" and any(char not in "12345" for char in value))):
            raise SchemeError("tone values must be 0 or one to six ASCII digits 1–5")
    return tuple(dict.fromkeys(values))


def _product_phonetic_letter(char):
    if not unicodedata.category(char).startswith("L"):
        return False
    point = ord(char)
    return ("LATIN" in unicodedata.name(char, "")
            or 0x0250 <= point <= 0x02ff or 0x1d00 <= point <= 0x1dbf
            or char in "βθχ")


def _product_phonetic_before(value, start):
    previous = start - 1
    while previous >= 0 and unicodedata.category(value[previous]).startswith("M"):
        previous -= 1
    return previous >= 0 and _product_phonetic_letter(value[previous])



def _product_mixed_notation(value, protected=()):
    plain, raised, mark = False, False, 0
    for at, char in enumerate(value):
        while mark < len(protected) and protected[mark][1] <= at:
            mark += 1
        if mark < len(protected) and protected[mark][0] <= at < protected[mark][1]:
            continue
        plain = plain or char in "0123456789"
        raised = raised or char in _SUPERSCRIPT_TO_DIGIT
        if plain and raised:
            return True
    return False

def convert_product_cell(value, legal, superscripts):
    """Opt-in product guard; legacy CLI convert_cell remains unchanged.

    Every decimal run outside an opaque @ placeholder must have a Latin/IPA
    stem. Detached digits, Han descriptions and half-raised runs refuse the
    whole cell; matching a contour alone is not enough to identify a reading.
    """
    try:
        legal = validate_product_legal(legal)
    except (SchemeError, TypeError):
        return Conversion(text=value, status=UNSUPPORTED, tones=(), reason="invalid_legal_values")
    if not value:
        return Conversion(text=value, status=EMPTY, tones=(), reason="")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return Conversion(text=value, status=UNSUPPORTED, tones=(), reason="invalid_utf8")
    protected = []
    for mark in PLACEHOLDER.finditer(value):
        if len(mark.group(0)) - 1 > PLACEHOLDER_MAX_HEX:
            return Conversion(text=value, status=UNSUPPORTED, tones=(),
                              reason="placeholder_out_of_spec_length")
        protected.append((mark.start(), mark.end()))
    if _product_mixed_notation(value, protected):
        return Conversion(text=value, status=UNSUPPORTED, tones=(),
                          reason="mixed_tone_notation")
    for match in DIGIT_RUN.finditer(value):
        if any(start <= match.start() < end for start, end in protected):
            continue
        if any(digit not in "0123456789" for digit in match.group(0)):
            return Conversion(text=value, status=UNSUPPORTED, tones=(),
                              reason="non_ascii_tone_digits")
        if not _product_phonetic_before(value, match.start()):
            return Conversion(text=value, status=UNSUPPORTED, tones=(),
                              reason="tone_digits_without_phonetic_context")
    trusted = {digit: char for digit, char in superscripts.items()
               if ALL_SUPERSCRIPTS.get(digit) == char}
    # The legacy codec deliberately uses a small recursive enumerator. Product
    # input can contain damaged runs thousands of digits long. Such a run cannot
    # equal any declared (<=6 digit) value; compute its refusal iteratively rather
    # than letting Python recursion fail. Ordinary cells retain the legacy path.
    runs = [match.group(0) for match in DIGIT_RUN.finditer(value)
            if not any(start <= match.start() < end for start, end in protected)]
    if any(len(run) > 128 for run in runs):
        status, reason = EXACT, ""
        for run in runs:
            if run in legal:
                missing = sorted(digit for digit in run if digit not in trusted)
                if missing:
                    return Conversion(text=value, status=UNSUPPORTED, tones=(),
                                      reason="superscript_untypeable:" + "".join(missing))
                continue
            contours, ways = _product_segment_info(run, frozenset(legal))
            if ways:
                detail = "tone_run_holds_%d_contours" % contours
                if ways > 1:
                    detail += "_in_%s%d_ways" % ("at_least_" if ways >= 4 else "", ways)
                status, reason = _worst(status, AMBIGUOUS), detail
            else:
                status, reason = UNSUPPORTED, "tone_run_not_a_legal_value"
        return Conversion(text=value, status=status, tones=(), reason=reason)
    return convert_cell(value, frozenset(legal), trusted)


def _product_segment_info(run, legal):
    """Longest-first contour count and up to four readings, without recursion."""
    width = max(map(len, legal))
    ways, contours = [0] * (len(run) + 1), [0] * (len(run) + 1)
    ways[-1] = 1
    for at in range(len(run) - 1, -1, -1):
        for size in range(min(width, len(run) - at), 0, -1):
            end = at + size
            if run[at:end] not in legal or not ways[end]:
                continue
            if not ways[at]:
                contours[at] = contours[end] + 1
            ways[at] = min(4, ways[at] + ways[end])
    return contours[0], ways[0]


def convert_tone_only_cell(value, legal, superscripts):
    """One declared contour without a syllable stem; preserve boundary spaces."""
    try:
        legal = validate_product_legal(legal)
    except (SchemeError, TypeError):
        return Conversion(text=value, status=UNSUPPORTED, tones=(), reason="invalid_legal_values")
    if not value:
        return Conversion(text=value, status=EMPTY, tones=(), reason="")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return Conversion(text=value, status=UNSUPPORTED, tones=(), reason="invalid_utf8")
    # Go unicode.IsSpace excludes Python's extra U+001C–001F control separators.
    is_space = lambda char: char.isspace() and char not in "\x1c\x1d\x1e\x1f"
    start, end = 0, len(value)
    while start < end and is_space(value[start]):
        start += 1
    while end > start and is_space(value[end - 1]):
        end -= 1
    core = value[start:end]
    if not core:
        return Conversion(text=value, status=NO_TONE, tones=(), reason="")
    if _product_mixed_notation(core):
        return Conversion(text=value, status=UNSUPPORTED, tones=(),
                          reason="mixed_tone_notation")
    if not all(char in "0123456789" for char in core):
        if all(char in _SUPERSCRIPT_TO_DIGIT for char in core):
            status = NO_TONE if flatten(core) in legal else UNSUPPORTED
            return Conversion(text=value, status=status, tones=(),
                              reason="" if status == NO_TONE else "tone_run_not_a_legal_value")
        for char in core:
            if unicodedata.category(char) == "Nd" and char not in "0123456789":
                return Conversion(text=value, status=UNSUPPORTED, tones=(),
                                  reason="non_ascii_tone_digits")
        return Conversion(text=value, status=UNSUPPORTED, tones=(),
                          reason="tone_only_requires_single_value")
    if core not in legal:
        return Conversion(text=value, status=UNSUPPORTED, tones=(),
                          reason="tone_run_not_a_legal_value")
    missing = sorted(digit for digit in core if superscripts.get(digit) != ALL_SUPERSCRIPTS[digit])
    if missing:
        return Conversion(text=value, status=UNSUPPORTED, tones=(),
                          reason="superscript_untypeable:" + "".join(missing))
    return Conversion(text=value[:start] + _raise(core, superscripts) + value[end:],
                      status=EXACT, tones=(core,), reason="")
