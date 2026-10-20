/**
 * Unified Form Filler - a Playwright-based filler for any job application
 * form, combining mechanical detection with AI decisions for field values.
 *
 * Core principles:
 * 1. fillForm NEVER submits. It fills fields, uploads documents and follows
 *    "Next"/"Continue" through multi-step forms, but never clicks anything
 *    that looks like Submit / Apply / Send / Finish on a form. Submitting is
 *    clickSubmit's job alone, and the worker only calls that after a human
 *    approved the application in the Review queue.
 * 2. Mechanical where predictable (file uploads, Next buttons, the "Apply"
 *    link on a job ad that opens the form).
 * 3. AI for field values (answerField), with the candidate's data.
 * 4. Fields the AI can't answer are recorded as human interventions in the
 *    snapshot the reviewer sees - not emailed one by one.
 */

const path = require('path');

const MAX_ITERATIONS = 20;

// Text of a control that would send the application. Never clicked by fillForm.
const SUBMIT_LIKE = /submit|send|apply|finish|complete|confirm|bewerb|envoyer|enviar/i;
// Text of a control that moves a multi-step form on without sending it.
const NEXT_LIKE = /^\s*(next|continue|proceed|save (and|&) continue|next step|weiter|suivant|siguiente)\b/i;
// "Continue with LinkedIn" and similar are sign-ins, not steps.
const SOCIAL_OR_AUTH = /with (linkedin|google|indeed|facebook|apple|microsoft)|sign ?in|log ?in|sign ?up|register/i;
// The link/button on a job ad that opens the application form.
const OPEN_FORM = /^\s*(apply|apply now|apply for this (job|position|role)|i'?m interested|start (your )?application)\s*$/i;
const CONFIRMATION = /application (has been |was )?(received|submitted|sent)|thank(s| you) for (applying|your application|your interest)|successfully (applied|submitted)|we('ve| have) received your application/i;

const FIELD_SELECTOR = [
  'input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
  'input[type="number"]', 'input[type="url"]', 'input[type="date"]',
  'input[type="radio"]', 'input[type="checkbox"]', 'textarea', 'select',
].join(', ');

class UnifiedFormFiller {
  constructor(page, api) {
    this.page = page;
    this.api = api;
    this.frame = page.mainFrame();
    this.formState = {
      currentStep: 0,
      visited: new Set(),
      uploaded: new Set(),
      filledFields: [],
      skippedFields: [],
      humanInterventions: [],
    };
  }

  /** Main entry point - fills every step of the form, stopping before submit. */
  async fillApplication(application, files) {
    console.log(`[${application.applicationId}] Starting unified form filling`);
    await this.settle();
    await this.openFormIfNeeded();
    await this.selectFormFrame();

    let lastUrl = this.page.url();
    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      await this.handleFileUploads(files);
      const processed = await this.fillVisibleFields(application);
      console.log(`[${application.applicationId}] Pass ${i}: ${processed} new field(s)`);
      if (processed) continue; // filling can reveal conditional fields - look again before moving on

      // Nothing new on this step: move to the next one, or stop (final step - submit waits for review)
      if (!(await this.clickNext())) break;
      this.formState.currentStep++;
      await this.settle();
      if (this.page.url() !== lastUrl) {
        lastUrl = this.page.url();
        this.formState.visited.clear();
        this.formState.uploaded.clear();
        await this.selectFormFrame();
      }
    }
    return this.buildResult();
  }

  async settle() {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await this.page.waitForTimeout(800);
  }

  /** Visible form controls in a frame. */
  async countFields(frame) {
    return frame.evaluate((sel) => Array.from(document.querySelectorAll(sel))
      .filter((el) => el.getClientRects().length && !el.disabled).length, FIELD_SELECTOR).catch(() => 0);
  }

  /** The frame holding the form: the one with the most visible fields (ATS forms are often embedded iframes). */
  async selectFormFrame() {
    let best = this.page.mainFrame();
    let bestCount = await this.countFields(best);
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const n = await this.countFields(frame);
      if (n > bestCount) { best = frame; bestCount = n; }
    }
    this.frame = best;
  }

  /**
   * On a job ad (no form yet), click its "Apply" link/button once to open the
   * form. Only when there is no form on the page - on a form, "Apply" means submit.
   */
  async openFormIfNeeded() {
    for (const frame of this.page.frames()) {
      if (await this.countFields(frame) >= 3) return;
    }
    const target = this.page.locator('a, button, [role="button"]').filter({ hasText: /apply|interested|application/i });
    for (const el of await target.all()) {
      const text = ((await el.textContent().catch(() => '')) || '').trim();
      const inForm = await el.evaluate((n) => !!n.closest('form')).catch(() => true);
      if (!OPEN_FORM.test(text) || inForm || !(await el.isVisible().catch(() => false))) continue;
      console.log(`Opening the application form via "${text}"`);
      await el.click();
      await this.settle();
      return;
    }
  }

  /** Everything the AI and the snapshot need to know about one control. */
  async describe(el) {
    return el.evaluate((n) => {
      const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      let label = '';
      if (n.labels && n.labels.length) label = n.labels[0].innerText;
      if (!label) label = n.getAttribute('aria-label') || '';
      if (!label && n.getAttribute('aria-labelledby')) {
        label = n.getAttribute('aria-labelledby').split(/\s+/)
          .map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
      }
      const group = n.closest('fieldset');
      const legend = group && group.querySelector('legend') ? group.querySelector('legend').innerText : '';
      const wrap = n.closest('div, li, fieldset');
      const context = wrap ? wrap.innerText.slice(0, 300) : '';
      return {
        tagName: n.tagName.toLowerCase(),
        type: (n.getAttribute('type') || (n.tagName === 'INPUT' ? 'text' : '')).toLowerCase(),
        id: n.id || '',
        name: n.getAttribute('name') || '',
        value: n.value || '',
        checked: !!n.checked,
        required: !!(n.required || n.getAttribute('aria-required') === 'true'),
        placeholder: n.getAttribute('placeholder') || '',
        label: text(label || legend || n.getAttribute('placeholder') || n.getAttribute('name')),
        groupLabel: text(legend),
        context: text(context),
        // Styled radios/checkboxes often hide the input itself behind a visible label
        visible: !!(n.getClientRects().length || (n.labels && n.labels[0] && n.labels[0].getClientRects().length)),
        disabled: !!(n.disabled || n.readOnly),
      };
    });
  }

  /** Fills every field on the current step not handled yet. Returns how many were new. */
  async fillVisibleFields(application) {
    let processed = 0;
    for (const el of await this.frame.locator(FIELD_SELECTOR).all()) {
      const info = await this.describe(el).catch(() => null);
      if (!info || !info.visible || info.disabled) continue;
      const key = this.fieldKey(info);
      if (this.formState.visited.has(key)) continue;
      this.formState.visited.add(key);
      processed++;

      // Pre-filled text (autofill, earlier step) is left alone
      if (!['radio', 'checkbox'].includes(info.type) && info.tagName !== 'select' && info.value) continue;

      try {
        await this.fillOne(el, info, application);
      } catch (err) {
        console.error(`Field "${info.label}" failed:`, err.message);
        this.formState.skippedFields.push({ label: info.label, reason: err.message });
      }
    }
    return processed;
  }

  /** One key per question: radio buttons of a group share theirs. */
  fieldKey(info) {
    if (info.type === 'radio') return `radio:${info.name || info.groupLabel}`;
    if (info.type === 'checkbox') return `checkbox:${info.name}:${info.id || info.label}`;
    return `${info.tagName}:${info.id || info.name || info.label}`;
  }

  async fillOne(el, info, application) {
    const options = await this.fieldOptions(el, info);
    const label = info.type === 'radio' ? (info.groupLabel || info.context || info.label) : info.label;
    const response = await this.api('answerField', {
      candidateId: application.candidateId,
      jobId: application.jobId,
      fieldInfo: {
        id: info.id || info.name,
        label,
        type: info.type,
        elementType: info.tagName,
        required: info.required,
        placeholder: info.placeholder,
        formGroup: info.context,
        options,
      },
      formContext: { url: this.page.url(), isMultiStep: this.formState.currentStep > 0, currentStep: this.formState.currentStep + 1 },
    });
    const decision = response.structuredDecision || {};
    const action = response.needsHuman ? 'human' : (decision.action || (response.answer ? 'fill' : 'skip'));
    const value = decision.value != null && decision.value !== '' ? String(decision.value) : (response.answer || '');

    if (action === 'human') {
      this.formState.humanInterventions.push({ label, reason: decision.reason || 'AI could not answer from the candidate data', required: info.required });
      return;
    }
    if (action === 'skip' || (['fill', 'select'].includes(action) && !value)) {
      this.formState.skippedFields.push({ label, reason: decision.reason || 'AI chose to skip' });
      return;
    }

    if (info.type === 'checkbox') {
      const want = action === 'check' || (action !== 'uncheck' && /^(true|yes|1|checked)$/i.test(value));
      if (want !== info.checked) await setChecked(el, want);
      this.formState.filledFields.push({ label, value: want ? 'Checked' : 'Unchecked' });
    } else if (info.type === 'radio') {
      const picked = await this.checkRadio(info, options, value);
      if (!picked) throw new Error(`No option matching "${value}"`);
      this.formState.filledFields.push({ label, value: picked });
    } else if (info.tagName === 'select') {
      const opt = options.find((o) => o.value === value) ||
        options.find((o) => o.text.toLowerCase() === value.toLowerCase());
      await el.selectOption(opt ? opt.value : { label: value });
      this.formState.filledFields.push({ label, value: opt ? opt.text : value });
    } else {
      await el.fill(value);
      this.formState.filledFields.push({ label, value });
    }
  }

  /** {value, text} options for a select or radio group. */
  async fieldOptions(el, info) {
    if (info.tagName === 'select') {
      return el.evaluate((n) => Array.from(n.options)
        .filter((o) => o.value && !o.disabled)
        .map((o) => ({ value: o.value, text: o.text.trim() })));
    }
    if (info.type === 'radio') {
      const radios = await this.radioGroup(info);
      const out = [];
      for (const r of radios) {
        const o = await r.evaluate((n) => ({
          value: n.value,
          text: ((n.labels && n.labels[0] && n.labels[0].innerText) || n.getAttribute('aria-label') || n.value || '').trim(),
        }));
        if (o.value || o.text) out.push(o);
      }
      return out;
    }
    if (info.type === 'checkbox') return [{ value: 'true', text: info.label }];
    return [];
  }

  radioGroup(info) {
    if (!info.name) return this.frame.locator(`input[type="radio"][id="${cssEscape(info.id)}"]`).all();
    return this.frame.locator(`input[type="radio"][name="${cssEscape(info.name)}"]`).all();
  }

  /** Checks the radio whose value or label matches; returns its label, or null. */
  async checkRadio(info, options, value) {
    const v = value.trim().toLowerCase();
    const idx = options.findIndex((o) => o.value.toLowerCase() === v) > -1
      ? options.findIndex((o) => o.value.toLowerCase() === v)
      : options.findIndex((o) => o.text.toLowerCase() === v);
    if (idx < 0) return null;
    const radios = await this.radioGroup(info);
    await setChecked(radios[idx], true);
    return options[idx].text || options[idx].value;
  }

  /** CV and cover letter into the matching file inputs, in every frame. */
  async handleFileUploads(files) {
    if (!files) return;
    const inputs = [];
    for (const frame of this.page.frames()) {
      for (const input of await frame.locator('input[type="file"]').all()) {
        const hint = await input.evaluate((n) => {
          const wrap = n.closest('div, li, fieldset, label');
          return [n.name, n.id, n.getAttribute('aria-label'), n.getAttribute('accept'),
            n.labels && n.labels[0] ? n.labels[0].innerText : '', wrap ? wrap.innerText.slice(0, 200) : '']
            .join(' ').toLowerCase();
        }).catch(() => '');
        inputs.push({ input, hint, key: hint });
      }
    }
    const fresh = inputs.filter((i) => !this.formState.uploaded.has(i.key));
    const put = async (i, file, what) => {
      await i.input.setInputFiles(file);
      this.formState.uploaded.add(i.key);
      this.formState.filledFields.push({ label: what, value: path.basename(file) });
      console.log(`Uploaded ${what}`);
    };
    const letterInput = fresh.find((i) => /cover|letter|motivation/.test(i.hint));
    const cvInput = fresh.find((i) => i !== letterInput && /resume|cv|curriculum|lebenslauf/.test(i.hint)) ||
      fresh.find((i) => i !== letterInput); // a single unlabelled upload is the CV
    if (cvInput && files.cv) await put(cvInput, files.cv, 'CV');
    if (letterInput && files.coverLetter) await put(letterInput, files.coverLetter, 'Cover letter');
  }

  /** Clicks a visible Next/Continue button (never a submit or sign-in). True if one was clicked. */
  async clickNext() {
    for (const el of await this.frame.locator('button, input[type="submit"], input[type="button"], [role="button"]').all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim();
      if (!NEXT_LIKE.test(text) || SUBMIT_LIKE.test(text) || SOCIAL_OR_AUTH.test(text)) continue;
      console.log(`Moving to the next step via "${text}"`);
      await el.click();
      return true;
    }
    return false;
  }

  buildResult() {
    return {
      system: 'unified-form-filler', // dashDecide recognises worker-filled applications by this
      stepsCompleted: this.formState.currentStep + 1,
      fieldsFilled: this.formState.filledFields.length,
      fieldsSkipped: this.formState.skippedFields.length,
      humanInterventions: this.formState.humanInterventions.length,
      filledFields: this.formState.filledFields,
      skippedFields: this.formState.skippedFields,
      interventions: this.formState.humanInterventions,
    };
  }
}

/** For a value inside a quoted attribute selector. */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/** Checks/unchecks a radio or checkbox, including ones hidden behind a styled label. */
async function setChecked(el, want) {
  if (await el.isVisible().catch(() => false)) return want ? el.check() : el.uncheck();
  // A DOM click on the hidden input fires the same events (and React handlers) as clicking its label
  await el.evaluate((n, w) => { if (n.checked !== w) n.click(); }, want);
}

/** Fills the whole form for review. Never submits - see clickSubmit. */
async function fillForm(page, application, files, candidate, api) {
  const filler = new UnifiedFormFiller(page, api);
  return filler.fillApplication(application, files, candidate);
}

/** True once any frame of the page shows a "we received your application" message. */
async function waitForConfirmation(page, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const frame of page.frames()) {
      const text = await frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      if (CONFIRMATION.test(text)) return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Submits the filled form - only ever called after a human approved it.
 * Returns true if the employer's confirmation was seen, false if Submit was
 * clicked but no confirmation appeared (the caller flags it for a person
 * rather than recording it as submitted). Throws if there is no submit button.
 */
async function clickSubmit(page) {
  // The frame holding the form first (embedded ATS iframes), so a page-header button can't win
  const filler = new UnifiedFormFiller(page, null);
  const counted = [];
  for (const frame of page.frames()) counted.push({ frame, n: await filler.countFields(frame) });
  counted.sort((a, b) => b.n - a.n);
  for (const { frame } of counted) {
    const candidates = frame.locator('button, input[type="submit"], [role="button"]');
    let fallback = null;
    for (const el of await candidates.all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim();
      if (SOCIAL_OR_AUTH.test(text) || NEXT_LIKE.test(text)) continue;
      if (/submit|send application|apply/i.test(text)) {
        await el.click();
        return waitForConfirmation(page, 20000);
      }
      if (!fallback && (await el.getAttribute('type').catch(() => '')) === 'submit' &&
          (await el.evaluate((n) => !!n.closest('form')).catch(() => false))) fallback = el;
    }
    if (fallback) {
      await fallback.click();
      return waitForConfirmation(page, 20000);
    }
  }
  throw new Error('Could not find the submit button');
}

module.exports = { fillForm, clickSubmit, UnifiedFormFiller };
