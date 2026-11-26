import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// A focused DOM regression with no access to the real user's configuration.
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;

const { createConfigEditorController, renderConfigEditor } =
  await import('../dist/ui/config-editor/src/app.js');
assert.equal(typeof renderConfigEditor, 'function',
  'config editor must expose its live render for DOM regression coverage');

const saved = new Map([
  ['enabledFeature', false],
  ['custom.key[0]', 'old'],
]);
const entries = () => [
  { key: 'enabledFeature', value: saved.get('enabledFeature'), valueType: 'boolean', editable: true },
  { key: 'custom.key[0]', value: saved.get('custom.key[0]'), valueType: 'string', editable: true },
];

let shouldReject = false;
const setCalls = [];
const tool = async (name, args) => {
  if (name === 'set_config_value') {
    setCalls.push(args);
    if (shouldReject) {
      return { isError: true, content: [{ type: 'text', text: 'Rejected edit' }] };
    }
    saved.set(args.key, args.value);
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  if (name === 'get_config') {
    return { structuredContent: { entries: entries() } };
  }
  throw new Error('Unexpected tool: ' + name);
};

const controller = createConfigEditorController(tool);
controller.setPayload({ entries: entries() });
const container = document.getElementById('app');
const tooltips = [];
renderConfigEditor(container, controller, {
  hideSummaryRow: false, compact: false, expanded: true
}, {
  onTooltip: (tip) => tooltips.push(tip)
});

const getStatus = (index) => container.querySelector('[data-save-status-index="' + index + '"]');
for (const i of [0, 1]) {
  const status = getStatus(i);
  assert.ok(status, 'missing local Saved status ' + i);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  assert.equal(status.textContent, '', 'live region must start empty');
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const input = container.querySelector('[data-action="edit-string"]');
assert.ok(input);
input.focus();
input.value = 'updated';
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(saved.get('custom.key[0]'), 'updated');
assert.equal(getStatus(1).textContent, 'Saved',
  'successful save must announce locally even for unusual key names');
assert.equal(getStatus(0).textContent, '', 'other setting must not announce a save');
assert.equal(document.activeElement, input, 'save must not replace or blur its input');
assert.equal(tooltips.length, 0, 'successful save should not invoke error tooltip');

// A no-op request should not claim another save.
getStatus(1).textContent = '';
const beforeNoop = setCalls.length;
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(setCalls.length, beforeNoop, 'no-op save should not submit');
assert.equal(getStatus(1).textContent, '', 'no-op save must not announce Saved');

// Failure is still surfaced through the existing error channel.
shouldReject = true;
input.value = 'rejected';
input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(getStatus(1).textContent, '');
assert.equal(tooltips.at(-1)?.tone, 'error');
assert.match(tooltips.at(-1)?.message ?? '', /Rejected edit/);
shouldReject = false;

const check = container.querySelector('[data-action="toggle-boolean"]');
assert.ok(check);
check.checked = true;
check.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await tick();
assert.equal(saved.get('enabledFeature'), true);
assert.equal(getStatus(0).textContent, 'Saved',
  'independent boolean setting must show its own announcement');
assert.equal(getStatus(1).textContent, '', 'failed setting must remain unannounced');

// A delayed response from an older request must not cancel the newer success.
let completeOlder;
let queuedWrites = 0;
const overlappingErrors = [];
const overlappedState = new Map([['custom.key[0]', 'old'], ['enabledFeature', false]]);
const overlappingTool = async (name, args) => {
  if (name === 'set_config_value') {
    queuedWrites++;
    if (queuedWrites === 1) {
      return new Promise((resolve) => { completeOlder = resolve; });
    }
    overlappedState.set(args.key, args.value);
    return {};
  }
  if (name === 'get_config') {
    return {
      structuredContent: {
        entries: entries().map((entry) => ({
          ...entry,
          value: overlappedState.get(entry.key)
        }))
      }
    };
  }
  throw new Error('Unexpected tool ' + name);
};
const overlapController = createConfigEditorController(overlappingTool);
overlapController.setPayload({
  entries: entries().map((entry) => ({
    ...entry,
    value: overlappedState.get(entry.key)
  }))
});
renderConfigEditor(container, overlapController, {
  hideSummaryRow: false, compact: false, expanded: true
}, { onTooltip: (tip) => overlappingErrors.push(tip) });
const overlapInput = container.querySelector('[data-action="edit-string"]');
overlapInput.value = 'first';
overlapInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(typeof completeOlder, 'function', 'first save must be pending');
overlapInput.value = 'second';
overlapInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(queuedWrites, 1,
  'newer same-key write must remain queued until the first save completes');
assert.equal(getStatus(1).textContent, '',
  'a queued save must not claim success before persistence');

// Re-render while both requests are active, simulating host context refresh.
renderConfigEditor(container, overlapController, {
  hideSummaryRow: false, compact: false, expanded: true
}, { onTooltip: (tip) => overlappingErrors.push(tip) });
const currentLiveRegion = getStatus(1);
completeOlder({
  isError: true,
  content: [{ type: 'text', text: 'obsolete failure' }]
});
await tick();
await tick();
assert.equal(queuedWrites, 2, 'next save must execute after the earlier one settles');
assert.equal(currentLiveRegion.textContent, 'Saved',
  'newly rendered live region must receive the eventual newer confirmation');
assert.equal(overlappingErrors.length, 0,
  'late older failure must not show an obsolete error tooltip');
assert.equal(overlappedState.get('custom.key[0]'), 'second');

// An older successful write must not persist after the newer request.
const persisted = new Map([['custom.key[0]', 'old'], ['enabledFeature', false]]);
const callOrder = [];
const changed = [];
let finishFirstWrite;
const orderedTool = async (name, args) => {
  if (name === 'set_config_value') {
    callOrder.push(args.value);
    if (args.value === 'first') {
      await new Promise((resolve) => { finishFirstWrite = resolve; });
    }
    persisted.set(args.key, args.value);
    return {};
  }
  if (name === 'get_config') {
    return { structuredContent: {
      entries: entries().map((entry) => ({
        ...entry,
        value: persisted.get(entry.key)
      }))
    } };
  }
  throw new Error('Unexpected tool ' + name);
};
const orderedController = createConfigEditorController(orderedTool);
orderedController.setPayload({ entries: entries().map((entry) => ({
  ...entry, value: persisted.get(entry.key)
})) });
renderConfigEditor(container, orderedController, {
  hideSummaryRow: false, compact: false, expanded: true
}, { onConfigChanged: (event) => changed.push(event) });
const orderedInput = container.querySelector('[data-action="edit-string"]');
orderedInput.value = 'first';
orderedInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(typeof finishFirstWrite, 'function');
orderedInput.value = 'second';
orderedInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.deepEqual(callOrder, ['first'],
  'same-key writes must be serialized through the complete refresh');
finishFirstWrite();
await tick();
await tick();
assert.deepEqual(callOrder, ['first', 'second']);
assert.equal(persisted.get('custom.key[0]'), 'second',
  'older successful write must never overwrite the later requested value');
assert.equal(orderedInput.value, 'second',
  'superseded handlers must not overwrite the latest input');
assert.deepEqual(changed.map((item) => item.value), ['second'],
  'only the accepted newest save should emit host model-context changes');
assert.equal(getStatus(1).textContent, 'Saved');

// Host rerender must preserve a completed confirmation while its timer remains.
renderConfigEditor(container, orderedController, {
  hideSummaryRow: false, compact: false, expanded: true
});
assert.equal(getStatus(1).textContent, 'Saved',
  'host refresh must rehydrate still-live confirmation');

// Array modal saves must also announce on their setting, not a separate row.
let savedFolders = ['C:/before'];
let rejectArraySave = false;
const arrayTool = async (name, args) => {
  if (name === 'set_config_value') {
    assert.equal(args.key, 'allowedDirectories');
    if (rejectArraySave) {
      return { isError: true, content: [{ type: 'text', text: 'Rejected array value' }] };
    }
    savedFolders = args.value;
    return {};
  }
  if (name === 'get_config') {
    return { structuredContent: { entries: [{
      key: 'allowedDirectories', value: savedFolders, valueType: 'array', editable: true
    }] } };
  }
  throw new Error('Unexpected tool ' + name);
};
const arrayController = createConfigEditorController(arrayTool);
arrayController.setPayload({ entries: [{
  key: 'allowedDirectories', value: savedFolders, valueType: 'array', editable: true
}] });
renderConfigEditor(container, arrayController, {
  hideSummaryRow: false, compact: false, expanded: true
});
container.querySelector('[data-action="open-array"]').click();
const modal = container.querySelector('#array-modal');
assert.equal(modal.hidden, false);
container.querySelector('#array-modal-new-item').value = 'C:/after';
container.querySelector('#array-modal-save').click();
await tick();
await tick();
assert.deepEqual(savedFolders, ['C:/after', 'C:/before']);
assert.equal(getStatus(0).textContent, 'Saved',
  'array modal save must announce on the correct setting row');
assert.equal(modal.hidden, true, 'successful array modal save should close');

// Failed list writes must keep the modal and its unsaved contents available.
rejectArraySave = true;
container.querySelector('[data-action="open-array"]').click();
container.querySelector('#array-modal-new-item').value = 'C:/unsaved';
container.querySelector('#array-modal-save').click();
await tick();
await tick();
assert.equal(modal.hidden, false, 'failed array save must leave modal open');
assert.match(container.querySelector('#array-modal-error').textContent, /Rejected array value/);
assert.equal(container.querySelector('#array-modal-new-item').value, 'C:/unsaved',
  'failed save must preserve the new unsaved item');
assert.deepEqual(savedFolders, ['C:/after', 'C:/before'], 'failed save must not alter persisted values');
rejectArraySave = false;
container.querySelector('#array-modal-save').click();
await tick();
await tick();
assert.deepEqual(savedFolders, ['C:/unsaved', 'C:/after', 'C:/before'],
  'retry should persist the unchanged modal inputs');
assert.equal(modal.hidden, true, 'successful retry should close the modal');

// Different keys may save concurrently, but an older refresh must not
// overwrite another setting's new draft or attach feedback to the wrong row.
const crossSaved = new Map([['alpha', 'A0'], ['beta', 'B0']]);
const crossEntries = () => ['alpha', 'beta'].map((key) => ({
  key, value: crossSaved.get(key), valueType: 'string', editable: true
}));
let finishAlpha;
const crossTool = async (name, args) => {
  if (name === 'set_config_value') {
    if (args.key === 'alpha') {
      await new Promise((resolve) => { finishAlpha = resolve; });
    }
    crossSaved.set(args.key, args.value);
    return {};
  }
  if (name === 'get_config') {
    return { structuredContent: { entries: crossEntries() } };
  }
  throw Error('Unexpected tool ' + name);
};
const crossController = createConfigEditorController(crossTool);
crossController.setPayload({ entries: crossEntries() });
renderConfigEditor(container, crossController, {
  hideSummaryRow: false, compact: false, expanded: true
});
const crossInputs = container.querySelectorAll('[data-action="edit-string"]');
crossInputs[0].value = 'A1';
crossInputs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(typeof finishAlpha, 'function');
crossInputs[1].value = 'B1';
crossInputs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
await tick();
assert.equal(crossSaved.get('beta'), 'B1',
  'other key should not be blocked by alpha save');
assert.equal(getStatus(1).textContent, 'Saved');
finishAlpha();
await tick();
await tick();
assert.equal(crossSaved.get('alpha'), 'A1');
assert.equal(crossSaved.get('beta'), 'B1');
assert.equal(getStatus(0).textContent, 'Saved');
assert.equal(getStatus(1).textContent, 'Saved');
assert.equal(crossInputs[1].value, 'B1',
  'older refresh must not revert the other setting input');

// A get_config response can itself be stale when another key saves first.
// The delayed old snapshot must not roll back a newer key's displayed value.
const snapshotSaved = new Map([['alpha', 'A0'], ['beta', 'B0']]);
const snapshotEntries = () => ['alpha', 'beta'].map((key) => ({
  key, value: snapshotSaved.get(key), valueType: 'string', editable: true
}));
let resumeOldSnapshot;
let heldOldSnapshot = false;
const snapshotTool = async (name, args) => {
  if (name === 'set_config_value') {
    snapshotSaved.set(args.key, args.value);
    return {};
  }
  if (name === 'get_config') {
    const entries = snapshotEntries();
    if (!heldOldSnapshot && snapshotSaved.get('alpha') === 'A1' &&
        snapshotSaved.get('beta') === 'B0') {
      heldOldSnapshot = true;
      await new Promise((resolve) => { resumeOldSnapshot = resolve; });
    }
    return { structuredContent: { entries } };
  }
  throw new Error('Unexpected tool ' + name);
};
const snapshotController = createConfigEditorController(snapshotTool);
snapshotController.setPayload({ entries: snapshotEntries() });
renderConfigEditor(container, snapshotController, {
  hideSummaryRow: false, compact: false, expanded: true
});
const snapshotInputs = container.querySelectorAll('[data-action="edit-string"]');
snapshotInputs[0].value = 'A1';
snapshotInputs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
assert.equal(typeof resumeOldSnapshot, 'function');
snapshotInputs[1].value = 'B1';
snapshotInputs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', {
  key: 'Enter', bubbles: true, cancelable: true
}));
await tick();
await tick();
assert.equal(snapshotController.state.payload.entries.find((e) => e.key === 'beta').value, 'B1');
resumeOldSnapshot();
await tick();
await tick();
assert.equal(snapshotController.state.payload.entries.find((e) => e.key === 'beta').value, 'B1',
  'a delayed snapshot for alpha must not overwrite beta after beta saves');

dom.window.close();
console.log('PASS config save feedback: ordered writes, host rerender, cross-setting overlap, array modal, failures, focus and no-op');
