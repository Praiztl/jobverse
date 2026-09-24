/**
 * Greenhouse module, rewritten to use AI-powered field answering instead of
 * hardcoded field mapping. The module now extracts all user-interactive fields
 * and asks the AI what to fill in each one, making it more flexible and
 * maintainable.
 *
 * This approach:
 * - Extracts all form fields (text inputs, dropdowns, checkboxes, etc.)
 * - Asks the AI to determine the answer for each field based on candidate data
 * - Handles file uploads (CV, cover letter) with platform-specific logic
 * - Skips fields the AI can't answer and continues with others
 * - Notifies human after completion about any skipped required fields
 */

async function formLocator_(page) {
  const iframe = page.frameLocator('iframe[src*="greenhouse.io"]').first();
  const hasIframe = await iframe.locator('body').count().catch(() => 0);
  return hasIframe ? iframe : page;
}

async function extractAllFields(form) {
  const fields = [];

  // Get all user-interactive input elements
  const elements = await form.locator(`
    input[type="text"],
    input[type="email"],
    input[type="tel"],
    input[type="number"],
    textarea,
    select,
    input[type="radio"],
    input[type="checkbox"]
  `).all();

  for (const element of elements) {
    const fieldInfo = await extractFieldContext(element);
    if (fieldInfo) {
      fields.push({
        element: element,
        ...fieldInfo
      });
    }
  }

  return fields;
}

async function extractFieldContext(element) {
  // Extract multiple possible label sources
  const label = await element.getAttribute('aria-label')
    || await element.getAttribute('placeholder')
    || await element.getAttribute('name')
    || await element.evaluate(el => {
      // Try to find associated label element
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent;
      }
      // Try parent label
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent;
      // Try nearby text
      const parent = el.parentElement;
      if (parent) {
        const text = parent.textContent.replace(el.value || '', '').trim();
        if (text) return text;
      }
      return '';
    });

  const type = await element.getAttribute('type') || 'text';
  const tagName = await element.evaluate(el => el.tagName.toLowerCase());
  const required = await element.getAttribute('required') === 'true';

  let options = [];

  // Handle different field types
  if (tagName === 'select') {
    options = await extractSelectOptions(element);
  } else if (type === 'radio') {
    options = await extractRadioOptions(element);
  } else if (type === 'checkbox') {
    options = await extractCheckboxOptions(element);
  }

  return {
    label: label?.trim(),
    type: tagName === 'select' ? 'dropdown' : type,
    inputType: type,
    required: required,
    name: await element.getAttribute('name'),
    id: await element.getAttribute('id'),
    options: options.length > 0 ? options : null
  };
}

async function extractSelectOptions(selectElement) {
  const options = await selectElement.locator('option').all();
  const optionData = [];

  for (const option of options) {
    const value = await option.getAttribute('value');
    const text = await option.textContent();
    if (value && text) {
      optionData.push({ value, text: text.trim() });
    }
  }

  return optionData;
}

async function extractRadioOptions(radioElement) {
  const name = await radioElement.getAttribute('name');
  if (!name) return [];

  const allRadios = await radioElement.page().locator(`input[type="radio"][name="${name}"]`).all();
  const options = [];

  for (const radio of allRadios) {
    const value = await radio.getAttribute('value');
    const label = await radio.evaluate(el => {
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent;
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent;
      return '';
    });

    if (value && label) {
      options.push({ value, text: label.trim() });
    }
  }

  return options;
}

async function extractCheckboxOptions(checkboxElement) {
  const name = await checkboxElement.getAttribute('name');
  if (!name) return [];

  const allCheckboxes = await checkboxElement.page().locator(`input[type="checkbox"][name="${name}"]`).all();
  const options = [];

  for (const checkbox of allCheckboxes) {
    const value = await checkbox.getAttribute('value');
    const label = await checkbox.evaluate(el => {
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent;
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent;
      return '';
    });

    if (value && label) {
      options.push({ value, text: label.trim() });
    }
  }

  return options;
}

async function fillField(page, element, answer, fieldInfo) {
  if (fieldInfo.type === 'dropdown') {
    await element.selectOption(answer);
  } else if (fieldInfo.inputType === 'radio') {
    const name = await element.getAttribute('name');
    const radio = page.locator(`input[type="radio"][name="${name}"][value="${answer}"]`);
    await radio.check();
  } else if (fieldInfo.inputType === 'checkbox') {
    if (Array.isArray(answer)) {
      for (const value of answer) {
        const checkbox = page.locator(`input[type="checkbox"][value="${value}"]`);
        await checkbox.check();
      }
    } else {
      await element.check();
    }
  } else {
    await element.fill(answer);
  }
}

async function handleFileUploads(form, files) {
  if (files.cv) {
    const cvInput = form.locator('input[type="file"]#resume, input[name="job_application[resume]"]');
    if (await cvInput.count()) await cvInput.setInputFiles(files.cv);
  }
  if (files.coverLetter) {
    const clInput = form.locator('input[type="file"]#cover_letter, input[name="job_application[cover_letter]"]');
    if (await clInput.count()) await clInput.setInputFiles(files.coverLetter);
  }
}

/** Fills the form and returns a snapshot for human review. Never submits. */
async function fillForm(page, application, files, candidate, api) {
  const form = await formLocator_(page);

  // Handle file uploads first (platform-specific)
  await handleFileUploads(form, files);

  // Extract all user-interactive fields
  const fields = await extractAllFields(form);

  const skippedFields = [];
  const filledFields = [];

  // For each field, ask AI what to fill
  for (const field of fields) {
    try {
      const { answer, needsHuman } = await api('answerField', {
        candidateId: application.candidateId,
        jobId: application.jobId,
        fieldInfo: {
          label: field.label,
          type: field.type,
          inputType: field.inputType,
          required: field.required,
          options: field.options
        }
      });

      if (needsHuman) {
        if (field.required) {
          skippedFields.push(field.label || field.name || 'unknown field');
        }
        continue; // Skip this field and continue with others
      }

      if (answer) {
        await fillField(page, field.element, answer, field);
        filledFields.push(field.label || field.name || 'unknown field');
      }
    } catch (err) {
      console.error(`Error filling field ${field.label || field.name}:`, err.message);
      if (field.required) {
        skippedFields.push(field.label || field.name || 'unknown field');
      }
    }
  }

  // If there were skipped required fields, notify human
  if (skippedFields.length > 0) {
    await api('captchaPause', {
      applicationId: application.applicationId,
      reason: 'SkippedRequiredFields',
      fields: skippedFields.join(', ')
    });
  }

  return {
    ats: 'greenhouse',
    fieldsFilled: filledFields.length,
    fieldsSkipped: skippedFields.length,
    skippedFields: skippedFields,
    cvAttached: !!files.cv,
    coverLetterAttached: !!files.coverLetter
  };
}

/** Only called after a human has approved the snapshot from fillForm. */
async function clickSubmit(page) {
  const form = await formLocator_(page);
  await form.locator('button#submit_app, button[type="submit"]').click();
  await page.waitForSelector('text=/application.*received|thank you|successfully submitted/i', { timeout: 15000 });
}

module.exports = { fillForm, clickSubmit };
