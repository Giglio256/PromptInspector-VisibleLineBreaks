// index.js - Prompt Inspector
// ContentEditable + First FULLY Visible Line + Anchor (ignore newlines)
//
// New in this build:
// - We strictly use the **first fully visible line** (not a 1‑px sliver).
// - We sample down the content box until a line's rect is entirely within the viewport.
// - Scrolling aligns that line’s TOP to the contentTop and verifies the whole line is visible.
// - Anchor still ignores real newlines and literal "\n" so the same first characters persist.
// - JSON-string-aware transforms preserved; edits in both modes; correct save behavior.
//
// -----------------------------------------------------------------------------

import { eventSource, event_types, main_api, stopGeneration } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { t } from '../../../i18n.js';

const path = 'third-party/PromptInspector-VisibleLineBreaks';

if (!('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) || !('CHAT_COMPLETION_PROMPT_READY' in event_types)) {
    toastr.error('Required event types not found. Update SillyTavern to the latest version.');
    throw new Error('Events not found.');
}

function isChatCompletion() {
    return main_api === 'openai';
}

function isLikelyJson(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    return t.startsWith('{') || t.startsWith('[');
}

// ───────────────────────────────────────────────────────────────────────────────
// Newline transforms (inside quoted JSON strings only)
// ───────────────────────────────────────────────────────────────────────────────
function jsonStringsDisplayNewlines(src) {
    if (!isLikelyJson(src)) return src;

    let out = '';
    let inStr = false;
    let backslashCount = 0;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (inStr) {
            if (ch === '\\') { backslashCount++; continue; }

            if (ch === '"') {
                const escapedQuote = (backslashCount % 2) === 1;
                out += '\\'.repeat(backslashCount) + '"';
                backslashCount = 0;
                if (!escapedQuote) inStr = false;
                continue;
            }

            if (ch === 'n' && backslashCount > 0) {
                if (backslashCount > 1) out += '\\'.repeat(backslashCount - 1);
                out += '\n';
                backslashCount = 0;
                continue;
            }

            out += '\\'.repeat(backslashCount) + ch;
            backslashCount = 0;
            continue;
        }

        if (ch === '"') inStr = true;
        out += ch;
    }

    if (backslashCount > 0) out += '\\'.repeat(backslashCount);
    return out;
}

function jsonStringsSaveNewlines(src) {
    if (!isLikelyJson(src)) return src;

    let out = '';
    let inStr = false;
    let backslashCount = 0;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (inStr) {
            if (ch === '\\') { backslashCount++; continue; }

            if (ch === '"') {
                const escapedQuote = (backslashCount % 2) === 1;
                out += '\\'.repeat(backslashCount) + '"';
                backslashCount = 0;
                if (!escapedQuote) inStr = false;
                continue;
            }

            if (ch === '\r') { continue; }

            if (ch === '\n') {
                out += '\\'.repeat(backslashCount) + '\\n';
                backslashCount = 0;
                continue;
            }

            out += '\\'.repeat(backslashCount) + ch;
            backslashCount = 0;
            continue;
        }

        if (ch === '"') inStr = true;
        out += ch;
    }

    if (backslashCount > 0) out += '\\'.repeat(backslashCount);
    return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// ContentEditable utilities
// ───────────────────────────────────────────────────────────────────────────────
function buildContentEditableFromTextarea($textarea) {
    const ta = $textarea.get(0);
    const ce = document.createElement('div');
    ce.id = 'inspectPromptCE';
    ce.contentEditable = 'true';

    const cs = getComputedStyle(ta);
    const copy = [
        'width','height','padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
        'border','borderTop','borderRight','borderBottom','borderLeft',
        'fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
        'boxSizing','tabSize','MozTabSize'
    ];
    ce.style.whiteSpace = 'pre-wrap';
    ce.style.wordBreak = 'break-word';
    ce.style.overflow = 'auto';
    ce.style.textAlign = 'left';

    for (const p of copy) { if (cs[p] != null) ce.style[p] = cs[p]; }
    ce.style.minHeight = cs.height;
    ce.className = ta.className;

    $textarea.after(ce);
    $textarea.hide();

    if (!ce.firstChild) ce.appendChild(document.createTextNode(''));
    return ce;
}

function ceGetText(ce) { return ce.textContent; }
function ceSetText(ce, text) {
    const node = ce.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== text) node.nodeValue = text;
    } else {
        ce.innerHTML = ''; ce.appendChild(document.createTextNode(text));
    }
}
function ceSetSelection(ce, start, end) {
    const sel = window.getSelection();
    const node = ce.firstChild;
    const len = node.nodeValue.length;
    const s = Math.max(0, Math.min(len, start|0));
    const e = Math.max(0, Math.min(len, end==null? s : end|0));
    const r = document.createRange();
    r.setStart(node, s); r.setEnd(node, e);
    sel.removeAllRanges(); sel.addRange(r);
}
function ceGetSelection(ce) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
    const r = sel.getRangeAt(0);
    const node = ce.firstChild;
    if (r.startContainer !== node || r.endContainer !== node) return { start: 0, end: 0 };
    return { start: r.startOffset, end: r.endOffset };
}

function caretOffsetFromClientXY(ce, x, y) {
    const doc = ce.ownerDocument;
    if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode === ce.firstChild) return pos.offset;
        if (pos) {
            const r = doc.createRange();
            r.setStart(pos.offsetNode, pos.offset);
            return Math.max(0, Math.min(ce.firstChild.length, r.startOffset));
        }
    }
    if (doc.caretRangeFromPoint) {
        const range = doc.caretRangeFromPoint(x, y);
        if (range) {
            const node = range.startContainer;
            const offset = range.startOffset;
            if (node === ce.firstChild) return offset;
            if (node === ce) return Math.max(0, Math.min(ce.firstChild.length, offset));
        }
    }
    return 0;
}

// Compute offset of the **first fully visible** line (top & bottom inside viewport)
function ceFirstFullyVisibleOffset(ce) {
    const rect = ce.getBoundingClientRect();
    const cs = getComputedStyle(ce);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const lh = parseFloat(cs.lineHeight) || 16;
    const contentTop = rect.top + padT;
    const contentBottom = rect.bottom - padB;
    const x = rect.left + padL + 1;

    // Start near top and step down by line height until fully visible
    let y = contentTop + lh * 0.6;
    for (let steps = 0; steps < 8; steps++) {
        const off = caretOffsetFromClientXY(ce, x, y);
        const r = document.createRange();
        const node = ce.firstChild;
        const len = node.length;
        const idx = Math.max(0, Math.min(len, off));
        r.setStart(node, idx); r.setEnd(node, idx);
        const caretRect = r.getBoundingClientRect();

        const topOK = caretRect.top >= contentTop - 0.5;
        const bottomOK = caretRect.bottom <= contentBottom + 0.5;
        if (topOK && bottomOK) return idx;

        if (caretRect.top < contentTop - 0.5) y += lh;
        else if (caretRect.bottom > contentBottom + 0.5) y -= lh * 0.5;
        else break;
    }
    return caretOffsetFromClientXY(ce, x, contentTop + lh * 0.6);
}

// Scroll and ensure the target line is fully visible
function ceScrollToOffsetFullyVisible(ce, targetOffset) {
    const cs = getComputedStyle(ce);
    const lh = parseFloat(cs.lineHeight) || 16;
    const rect = ce.getBoundingClientRect();
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const contentTop = rect.top + padT;
    const contentBottom = rect.bottom - padB;

    const range = document.createRange();
    const text = ce.firstChild;
    const len = text.length;
    const idx = Math.max(0, Math.min(len, targetOffset|0));
    range.setStart(text, idx); range.setEnd(text, idx);

    // Align top to contentTop
    let caretRect = range.getBoundingClientRect();
    ce.scrollTop += (caretRect.top - contentTop);

    // Ensure bottom fits
    caretRect = range.getBoundingClientRect();
    const overflowBottom = caretRect.bottom - contentBottom;
    if (overflowBottom > 0) ce.scrollTop += overflowBottom + 1;

    // Small interior margin at top
    caretRect = range.getBoundingClientRect();
    const desiredTop = contentTop + lh * 0.2;
    const err = caretRect.top - desiredTop;
    if (Math.abs(err) > 0.5) ce.scrollTop += err;
}

// ───────────────────────────────────────────────────────────────────────────────
// Anchor: build & match while ignoring newlines (real \n, CR, and literal "\n")
// ───────────────────────────────────────────────────────────────────────────────
function isLiteralBackslashN(text, i) { return text[i] === '\\' && text[i+1] === 'n'; }
function isRealNewline(ch) { return ch === '\n' || ch === '\r'; }

function buildAnchorIgnoringNewlines(text, startIdx, count = 30) {
    let out = '';
    let i = Math.max(0, startIdx|0);
    while (i < text.length && out.length < count) {
        if (isLiteralBackslashN(text, i)) { i += 2; continue; }
        const ch = text[i];
        if (isRealNewline(ch)) { i += 1; continue; }
        out += ch; i += 1;
    }
    return out;
}

function findAnchorIgnoringNewlines(text, anchor, aroundIndex, radius = 4096) {
    if (!anchor || anchor.length === 0) return aroundIndex;
    const start = Math.max(0, aroundIndex - radius);
    const end = Math.min(text.length, aroundIndex + radius);

    function tryScan(from, to, step) {
        for (let s = from; (step > 0 ? s <= to : s >= to); s += step) {
            let ti = s, ai = 0, firstIndex = -1;
            while (ti < text.length && ti >= 0 && ai < anchor.length) {
                if (isLiteralBackslashN(text, ti)) { ti += 2; continue; }
                const ch = text[ti];
                if (isRealNewline(ch)) { ti += (step > 0 ? 1 : -1); continue; }
                if (anchor[ai] !== ch) break;
                if (firstIndex === -1) firstIndex = ti;
                ai += 1; ti += 1;
            }
            if (ai === anchor.length) return firstIndex;
        }
        return -1;
    }

    let idx = tryScan(aroundIndex, end, +1);
    if (idx !== -1) return idx;
    idx = tryScan(aroundIndex, start, -1);
    if (idx !== -1) return idx;
    return aroundIndex;
}

// ───────────────────────────────────────────────────────────────────────────────
// UI & event wiring
// ───────────────────────────────────────────────────────────────────────────────
function addLaunchButton() {
    const enabledText = t`Stop Inspecting`;
    const disabledText = t`Inspect Prompts`;
    const enabledIcon = 'fa-solid fa-bug-slash';
    const disabledIcon = 'fa-solid fa-bug';

    const getIcon = () => inspectEnabled ? enabledIcon : disabledIcon;
    const getText = () => inspectEnabled ? enabledText : disabledText;

    const launchButton = document.createElement('div');
    launchButton.id = 'inspectNextPromptButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = t`Toggle prompt inspection`;
    const icon = document.createElement('i');
    icon.className = getIcon();
    launchButton.appendChild(icon);
    const textSpan = document.createElement('span');
    textSpan.textContent = getText();
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('prompt_inspector_wand_container') ?? document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        throw new Error('Could not find the extensions menu');
    }
    extensionsMenu.classList.add('interactable');
    extensionsMenu.tabIndex = 0;

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', () => {
        toggleInspectNext();
        textSpan.textContent = getText();
        icon.className = getIcon();
    });
}

let inspectEnabled = localStorage.getItem('promptInspectorEnabled') === 'true' || false;

function toggleInspectNext() {
    inspectEnabled = !inspectEnabled;
    toastr.info(`Prompt inspection is now ${inspectEnabled ? 'enabled' : 'disabled'}`);
    localStorage.setItem('promptInspectorEnabled', String(inspectEnabled));
}

// Persist view choice
function getShowNewlinesDefault() {
    const v = localStorage.getItem('promptInspectorShowNewlines');
    return v === null ? 'true' : v;
}
function setShowNewlines(v) {
    localStorage.setItem('promptInspectorShowNewlines', String(v));
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (!inspectEnabled) return;
    if (data.dryRun) return;
    if (!isChatCompletion()) return;

    const promptJson = JSON.stringify(data.chat, null, 4);
    const result = await showPromptInspector(promptJson);
    if (result === promptJson) return;

    try {
        const chat = JSON.parse(result);
        if (Array.isArray(chat) && Array.isArray(data.chat)) {
            data.chat.splice(0, data.chat.length, ...chat);
        }
    } catch (e) {
        console.error('Prompt Inspector: Invalid JSON', e);
        toastr.error('Invalid JSON');
    }
});

eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, async (data) => {
    if (!inspectEnabled) return;
    if (data.dryRun) return;
    if (isChatCompletion()) return;

    const result = await showPromptInspector(data.prompt);
    if (result === data.prompt) return;

    data.prompt = result;
});

/**
 * Popup with contenteditable editor and strict "first fully visible line" behavior.
 * @param {string} input
 * @returns {Promise<string>}
 */
async function showPromptInspector(input) {
    const template = $(await renderExtensionTemplateAsync(path, 'template'));
    const $ta = template.find('#inspectPrompt'); // original textarea in template
    const isJson = isLikelyJson(input);

    const ce = buildContentEditableFromTextarea($ta);

    let showNewlines = getShowNewlinesDefault() !== 'false'; // default true
    const initialText = (showNewlines && isJson) ? jsonStringsDisplayNewlines(input) : input;
    ceSetText(ce, initialText);

    // Centered toggle button under editor
    const toggleWrap = $(`
        <div id="linebreakToggleWrap" style="text-align:center;margin-top:8px;margin-bottom:8px;">
            <button id="linebreakToggleBtn"
                class="menu_button"
                style="display:inline-flex;align-items:center;gap:8px;white-space:nowrap;padding:6px 12px;max-width:100%;"
                type="button"
                title="Toggle between raw (\\n) and real line breaks"
                aria-pressed="${showNewlines ? 'true' : 'false'}">
                <i id="linebreakToggleIcon" class="${showNewlines ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'}"></i>
                <span>Toggle line breaks</span>
            </button>
        </div>
    `);
    $(ce).after(toggleWrap);
    if (!isJson) toggleWrap.hide();

    function flipIcon(isNewlines) {
        const icon = toggleWrap.find('#linebreakToggleIcon').get(0);
        if (icon) icon.className = isNewlines ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        const btn = toggleWrap.find('#linebreakToggleBtn').get(0);
        if (btn) {
            btn.setAttribute('aria-pressed', isNewlines ? 'true' : 'false');
            btn.title = isNewlines ? 'Show raw with \\n' : 'Show real line breaks';
        }
    }

    toggleWrap.on('click', '#linebreakToggleBtn', () => {
        const current = ceGetText(ce);
        // 1) First FULLY visible offset
        const topOffset = ceFirstFullyVisibleOffset(ce);

        // 2) Anchor of first 30 chars ignoring newlines
        const ANCHOR_LEN = 30;
        const anchor = buildAnchorIgnoringNewlines(current, topOffset, ANCHOR_LEN);

        // 3) Save selection (optional)
        const { start, end } = ceGetSelection(ce);

        // 4) Map + transform + anchor match
        let newText, mappedIndex, targetIndex;
        if (showNewlines) {
            mappedIndex = isJson ? mapFriendlyTopToRawIndex(current, topOffset) : topOffset;
            newText = isJson ? jsonStringsSaveNewlines(current) : current;
            targetIndex = findAnchorIgnoringNewlines(newText, anchor, mappedIndex, 4096);
            ceSetText(ce, newText);
            ceScrollToOffsetFullyVisible(ce, targetIndex);
            showNewlines = false;
        } else {
            mappedIndex = isJson ? mapRawTopToFriendlyIndex(current, topOffset) : topOffset;
            newText = isJson ? jsonStringsDisplayNewlines(current) : current;
            targetIndex = findAnchorIgnoringNewlines(newText, anchor, mappedIndex, 4096);
            ceSetText(ce, newText);
            ceScrollToOffsetFullyVisible(ce, targetIndex);
            showNewlines = true;
        }

        try { ceSetSelection(ce, start, end); } catch {}

        setShowNewlines(showNewlines);
        flipIcon(showNewlines);
    });

    // Cancel button
    /** @type {import('../../../popup').CustomPopupButton} */
    const customButton = {
        text: 'Cancel generation',
        result: POPUP_RESULT.CANCELLED,
        appendAtEnd: true,
        action: async () => {
            await stopGeneration();
            await popup.complete(POPUP_RESULT.CANCELLED);
        },
    };

    const popup = new Popup(
        template,
        POPUP_TYPE.CONFIRM,
        '',
        { wide: true, large: true, okButton: 'Save changes', cancelButton: 'Discard changes', customButtons: [customButton] }
    );
    const result = await popup.show();
    if (!result) return input;

    const finalText = ceGetText(ce);
    if (isJson && showNewlines) return jsonStringsSaveNewlines(finalText);
    return finalText;
}

// ───────────────────────────────────────────────────────────────────────────────
// Index mapping helpers
// ───────────────────────────────────────────────────────────────────────────────
function mapRawTopToFriendlyIndex(src, rawIndex) {
    let friendly = 0;
    let inStr = false;
    let backslashCount = 0;
    for (let i = 0; i < src.length && i < rawIndex; i++) {
        const ch = src[i];
        if (inStr) {
            if (ch === '\\') { backslashCount++; continue; }
            if (ch === '"') {
                const escaped = (backslashCount % 2) === 1;
                friendly += backslashCount + 1;
                backslashCount = 0;
                if (!escaped) inStr = false;
                continue;
            }
            if (ch === 'n' && backslashCount > 0) {
                if (backslashCount > 1) friendly += backslashCount - 1;
                friendly += 1;
                backslashCount = 0;
                continue;
            }
            friendly += backslashCount + 1;
            backslashCount = 0;
            continue;
        }
        if (ch === '"') inStr = true;
        friendly += 1;
    }
    if (backslashCount > 0) friendly += backslashCount;
    return friendly;
}
function mapFriendlyTopToRawIndex(src, friendlyIndex) {
    let raw = 0;
    let inStr = false;
    let backslashCount = 0;
    for (let i = 0; i < src.length && i < friendlyIndex; i++) {
        const ch = src[i];
        if (inStr) {
            if (ch === '\\') { backslashCount++; raw += 1; continue; }
            if (ch === '"') {
                const escaped = (backslashCount % 2) === 1;
                raw += 1;
                backslashCount = 0;
                if (!escaped) inStr = false;
                continue;
            }
            if (ch === '\r') { raw += 1; backslashCount = 0; continue; }
            if (ch === '\n') { raw += 2; backslashCount = 0; continue; }
            raw += 1; backslashCount = 0; continue;
        }
        if (ch === '"') inStr = true;
        raw += 1;
    }
    return raw;
}

(function init() {
    addLaunchButton();
})();
