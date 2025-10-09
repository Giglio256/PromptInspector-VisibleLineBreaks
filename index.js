
// index.js - Prompt Inspector Extension (Corrected)
// Purpose: Show \n as real newlines *inside JSON strings only*, while preserving any preceding backslashes.
//          On save, convert actual newlines back to \n inside JSON strings. Do not alter anything else.

import { eventSource, event_types, main_api, stopGeneration } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { t } from '../../../i18n.js';

const path = 'third-party/Extension-PromptInspector';

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

/**
 * Display conversion: inside quoted JSON strings, turn any single backslash+'n' pair into a real newline,
 * but preserve any other characters (including preceding backslashes). Outside strings: no changes.
 * Correctly handles escaped quotes.
 */
function jsonStringsDisplayNewlines(src) {
    if (!isLikelyJson(src)) return src;

    let out = '';
    let inStr = false;
    let backslashCount = 0;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (inStr) {
            if (ch === '\\') {
                backslashCount++;
                continue;
            }

            if (ch === '"') {
                // Quote may be escaped if an odd number of backslashes directly precedes it
                const escapedQuote = (backslashCount % 2) === 1;
                out += '\\'.repeat(backslashCount) + '"';
                backslashCount = 0;
                if (!escapedQuote) {
                    inStr = false; // end of string
                }
                continue;
            }

            // If we see 'n' and have at least one preceding backslash, consume exactly one '\' to form newline
            if (ch === 'n' && backslashCount > 0) {
                if (backslashCount > 1) out += '\\'.repeat(backslashCount - 1); // preserve all but one
                out += '\n'; // the \n pair becomes a real newline
                backslashCount = 0;
                continue;
            }

            // Any other char: flush pending backslashes then the char
            out += '\\'.repeat(backslashCount) + ch;
            backslashCount = 0;
            continue;
        }

        // Outside strings
        if (ch === '"') {
            inStr = true;
        }
        out += ch;
    }

    // Flush dangling backslashes if the JSON was malformed (defensive)
    if (backslashCount > 0) out += '\\'.repeat(backslashCount);

    return out;
}

/**
 * Save conversion: inside quoted JSON strings, convert actual newlines (LF) into \n.
 * Preserve everything else exactly. Handle CRLF normalization.
 * Correctly handles escaped quotes.
 */
function jsonStringsSaveNewlines(src) {
    if (!isLikelyJson(src)) return src;

    let out = '';
    let inStr = false;
    let backslashCount = 0;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (inStr) {
            if (ch === '\\') {
                // Backslash as a normal character inside a string
                backslashCount++;
                continue;
            }

            if (ch === '"') {
                const escapedQuote = (backslashCount % 2) === 1;
                out += '\\'.repeat(backslashCount) + '"';
                backslashCount = 0;
                if (!escapedQuote) {
                    inStr = false;
                }
                continue;
            }

            // Normalize CRLF or CR-only into \n; we handle just '\n' emission
            if (ch === '\r') {
                // Skip CR; if next is LF it will be handled below
                continue;
            }

            if (ch === '\n') {
                // Convert newline back into \n escape
                out += '\\'.repeat(backslashCount) + '\\n';
                backslashCount = 0;
                continue;
            }

            // Any other char
            out += '\\'.repeat(backslashCount) + ch;
            backslashCount = 0;
            continue;
        }

        // Outside strings
        if (ch === '"') {
            inStr = true;
        }
        out += ch;
    }

    if (backslashCount > 0) out += '\\'.repeat(backslashCount);

    return out;
}

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

async function showPromptInspector(input) {
    const template = $(await renderExtensionTemplateAsync(path, 'template'));
    const prompt = template.find('#inspectPrompt');

    // Display with \n -> newline ONLY inside JSON strings, preserving extra backslashes
    const displayText = jsonStringsDisplayNewlines(input);
    prompt.val(displayText);

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

    if (!result) {
        return input;
    }

    // On save, newline -> \n ONLY inside JSON strings
    return jsonStringsSaveNewlines(String(prompt.val()));
}

(function init() {
    addLaunchButton();
})();
