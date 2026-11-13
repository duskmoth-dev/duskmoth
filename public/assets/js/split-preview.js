import * as api from './api.js?mode=real';
import * as passes from './passes.js';
import { MIN_PART, planSplit, quoteSplit } from './split-withdraw.js';
export async function addSplitOption({ action, card, config, baseQuote, selection, updateQuote, inactive }) {
  const box = document.createElement('div');
  box.className = 'split-option';
  card.querySelector('.actions').before(box);
  if (action.amount < 2 * MIN_PART[action.token]) {
    box.textContent = `Split withdraw needs at least ${2 * MIN_PART[action.token]} ${action.token}.`;
    return;
  }
  const label = document.createElement('label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = true;
  const text = document.createElement('span'); text.textContent = 'Split withdraw · checking Moth Pass availability…';
  label.append(checkbox, text);
  const status = document.createElement('p'); status.className = 'micro mute'; status.setAttribute('role', 'status');
  const link = document.createElement('a'); link.href = '/pass'; link.textContent = 'Get passes';
  box.append(label, status, link);
  let info, plan, quote;
  function reset() { checkbox.checked = false; selection.plan = null; selection.quotes = null; selection.info = null; updateQuote(baseQuote); }
  const refresh = () => {
    if (inactive()) { checkbox.disabled = true; return; }
    try {
      const count = info?.enabled ? passes.count(info.kid, info.demo) : null;
      checkbox.disabled = !info?.enabled || !(count > 0) || !plan;
      if (checkbox.disabled && checkbox.checked) reset();
      text.textContent = plan
        ? `Split into ${plan.length} random parts (${plan.map(part => part.amount).join(' + ')} ${action.token})`
        : 'Split withdrawal is unavailable for this amount at the current relayer minimum.';
      status.textContent = info?.enabled
        ? `Uses 1 Moth Pass · you have ${count}. Each part pays its own relayer fee. Waits are 30–120 s; keep this tab open. An interrupted run may leave remaining funds private.`
        : 'Moth Pass is unavailable. Normal withdrawal remains free to use.';
    } catch {
      checkbox.disabled = true;
      if (checkbox.checked) reset();
      status.textContent = 'Stored passes are unavailable. Keep your browser data and backup. Normal withdrawal remains available.';
    }
  };
  checkbox.addEventListener('change', () => {
    if (inactive()) return;
    if (checkbox.checked) {
      selection.plan = plan; selection.quotes = quote.quotes; selection.info = info;
      updateQuote(quote);
    } else reset();
  });
  try {
    info = await api.passInfo();
    plan = planSplit(action.amount, action.token);
    try { quote = quoteSplit(action, plan, config); } catch { plan = null; }
    refresh();
  } catch {
    checkbox.disabled = true;
    text.textContent = 'Split withdrawal is unavailable.';
    status.textContent = 'Pass availability or per-part fees could not be verified. Normal withdrawal remains available.';
  }
  addEventListener('passes:change', refresh);
}
