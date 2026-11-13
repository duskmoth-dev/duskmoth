import { withdrawalPrivacy } from './api.js';

// Build result text with DOM text nodes, never provider-controlled markup.
export function mountWithdrawalPrivacy({ card, action, sender, inactive }) {
  const section = document.createElement('section');
  section.className = 'withdraw-privacy';
  section.style.cssText = 'margin:12px 0;padding:12px;overflow-wrap:anywhere;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.04);font-size:13px;line-height:1.6';
  section.setAttribute('aria-label', 'Pre-withdraw privacy check');
  const heading = document.createElement('h4');
  heading.textContent = 'Pre-withdraw privacy check';
  const explanation = document.createElement('p');
  explanation.className = 'micro';
  explanation.style.textTransform = 'none';
  explanation.textContent = 'Free, optional, read-only. Sends the two public addresses and proposed amount to Duskmoth; Helius receives public-history queries. No signature, pass or funds required. Results are not retained by this feature.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'Check withdrawal privacy';
  const output = document.createElement('div');
  output.setAttribute('role', 'status');
  output.setAttribute('aria-live', 'polite');
  section.append(heading, explanation, button, output);
  card.querySelector('.actions').before(section);
  let generation = 0;
  button.addEventListener('click', async () => {
    if (inactive()) return;
    const current = ++generation;
    button.disabled = true;
    output.textContent = 'Checking confirmed Solana mainnet history…';
    try {
      const report = await withdrawalPrivacy({ sender, recipient: action.recipient, token: action.token, amount: action.amount });
      if (current !== generation) return;
      if (inactive()) { output.textContent = 'This preview is no longer active. Create a new preview to check your current plan.'; return; }
      if (report.network !== 'solana-mainnet' || !Array.isArray(report.checks)) throw new Error('Invalid privacy report. Retry the check.');
      output.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = `${report.warningCount} potential exposure signal(s) · ${report.status === 'partial' ? 'Partial data' : 'Limited sample'} · ${new Date(report.checkedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`;
      output.append(summary);
      const list = document.createElement('ul');
      list.style.cssText = 'padding-left:18px;display:grid;gap:10px';
      for (const check of report.checks) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = `${check.status === 'warning' ? 'Caution' : check.status === 'unknown' ? 'Unknown' : 'Observed'} — ${check.title}. `;
        item.append(title, document.createTextNode(check.detail));
        for (const signature of check.evidence || []) {
          if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) continue;
          const link = document.createElement('a');
          link.href = `https://solscan.io/tx/${signature}`;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = ' View public transaction';
          item.append(link);
        }
        list.append(item);
      }
      const note = document.createElement('p');
      note.className = 'micro';
      note.style.textTransform = 'none';
      note.textContent = `${report.limitations} Reviewed gross amount: ${action.amount} ${action.token}. ${report.coverage.transactionsInspected}/${report.coverage.transactionLimit} recent sender transactions inspected; usable amount data: ${report.coverage.amountTransactionsInspected ?? 'unknown'}. This is a snapshot; run again if your plan changes.`;
      const suggestions = document.createElement('p');
      suggestions.textContent = (report.suggestions || []).join(' ');
      output.append(list, suggestions, note);
    } catch (error) {
      if (current === generation && !inactive()) output.textContent = `${error.message} No pass was spent and nothing was submitted. Normal withdrawal remains available after its required checks.`;
    } finally {
      if (current === generation) {
        button.disabled = inactive();
        button.textContent = 'Check again';
      }
    }
  });
  return { invalidate() {
    generation++;
    button.disabled = inactive();
    output.textContent = 'Plan updated. Run the check for the gross total; individual split amounts are not assessed.';
  } };
}
