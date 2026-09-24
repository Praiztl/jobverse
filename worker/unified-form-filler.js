/**
 * Unified Form Filler - A Playwright-based system that can fill any job application form
 * by combining mechanical detection with AI-powered decision making.
 *
 * Core principles:
 * 1. Mechanical operations: handle predictable patterns automatically (buttons, navigation)
 * 2. AI-powered decisions: ask AI for complex decisions (field values, ambiguous elements)
 * 3. Human intervention: detect and flag situations requiring human help (CAPTCHAs, unusual patterns)
 * 4. Progressive enhancement: start with mechanical, fall back to AI, escalate to human
 */

const { chromium } = require('playwright');

class UnifiedFormFiller {
  constructor(page, api) {
    this.page = page;
    this.api = api;
    this.formState = {
      currentStep: 0,
      totalSteps: 0,
      visitedElements: new Set(),
      filledFields: [],
      skippedFields: [],
      humanInterventions: []
    };
  }

  /**
   * Main entry point - fills a complete application form
   */
  async fillApplication(application, files, candidate) {
    console.log(`[${application.applicationId}] Starting unified form filling`);
    
    try {
      // Initial page analysis
      await this.analyzePage();
      
      // Handle file uploads first (mechanical)
      await this.handleFileUploads(files);
      
      // Main form filling loop
      let maxIterations = 20; // Prevent infinite loops
      let iterations = 0;
      
      while (iterations < maxIterations && !await this.isFormComplete()) {
        iterations++;
        console.log(`[${application.applicationId}] Form iteration ${iterations}`);
        
        // Detect all interactive elements
        const elements = await this.detectInteractiveElements();
        
        // Process each element
        for (const { element, info, context } of elements) {
          const elementId = this.generateElementId(info);
          if (this.formState.visitedElements.has(elementId)) {
            continue; // Skip already processed elements
          }
          
          const action = await this.decideAction(element, info, application, candidate);
          await this.executeAction(element, action, application, candidate, info);
          
          this.formState.visitedElements.add(elementId);
        }
        
        // Check for navigation/multi-step forms
        await this.handleNavigation();
        
        // Wait for page stability
        await this.page.waitForTimeout(1000);
      }
      
      return this.buildResult();
    } catch (error) {
      console.error(`[${application.applicationId}] Form filling error:`, error.message);
      throw error;
    }
  }

  /**
   * Analyze the initial page state
   */
  async analyzePage() {
    this.formState.initialUrl = this.page.url();
    this.formState.pageTitle = await this.page.title();
    
    // Detect if there's an iframe (common in ATS systems)
    const frames = this.page.frames();
    this.formState.hasIframe = frames.length > 1;
    
    console.log(`Page analysis: ${this.formState.pageTitle}, iframe: ${this.formState.hasIframe}`);
  }

  /**
   * Detect all interactive elements on the page
   */
  async detectInteractiveElements() {
    const elements = [];
    
    // Get the appropriate context (page or iframe)
    let context;
    try {
      if (this.formState.hasIframe) {
        const iframe = this.page.frameLocator('iframe').first();
        const hasIframe = await iframe.locator('body').count().catch(() => 0);
        context = hasIframe > 0 ? iframe : this.page;
      } else {
        context = this.page;
      }
    } catch (error) {
      context = this.page;
    }
    
    // Detect all interactive elements
    const selectors = [
      'input[type="text"]',
      'input[type="email"]', 
      'input[type="tel"]',
      'input[type="number"]',
      'input[type="file"]',
      'textarea',
      'select',
      'input[type="radio"]',
      'input[type="checkbox"]',
      'button',
      'a[href]',
      '[role="button"]',
      '[onclick]'
    ];
    
    for (const selector of selectors) {
      try {
        const matched = await context.locator(selector).all();
        for (const element of matched) {
          const info = await this.extractElementInfo(element);
          if (info && info.isVisible) {
            elements.push({ element, info, context });
          }
        }
      } catch (error) {
        // Selector might not match anything, continue
      }
    }
    
    return elements;
  }

  /**
   * Extract comprehensive information about an element
   */
  async extractElementInfo(element) {
    try {
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const type = await element.getAttribute('type') || '';
      const id = await element.getAttribute('id') || '';
      const name = await element.getAttribute('name') || '';
      const className = await element.getAttribute('class') || '';
      const text = await element.textContent().catch(() => '');
      const ariaLabel = await element.getAttribute('aria-label') || '';
      const placeholder = await element.getAttribute('placeholder') || '';
      const value = await element.inputValue().catch(() => '');
      const href = await element.getAttribute('href') || '';
      
      // Get nearby text for context
      const nearbyText = await element.evaluate(el => {
        const parent = el.parentElement;
        if (parent) {
          return parent.textContent.replace(el.value || '', '').trim().substring(0, 200);
        }
        return '';
      }).catch(() => '');
      
      return {
        tagName,
        type,
        id,
        name,
        className,
        text: text?.trim(),
        ariaLabel,
        placeholder,
        value,
        href,
        nearbyText,
        isVisible: await element.isVisible().catch(() => false)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Decide what action to take for an element
   * Returns: 'mechanical-click', 'ai-fill', 'ai-click', 'human-intervention', 'skip'
   */
  async decideAction(element, elementInfo, application, candidate) {
    // Mechanical detection for common patterns
    const mechanicalAction = this.detectMechanicalAction(elementInfo);
    if (mechanicalAction) {
      return { type: mechanicalAction, confidence: 'high' };
    }
    
    // Detect inputs that need AI-powered filling
    if (this.isInputField(elementInfo)) {
      // Ask AI if this field needs filling or should be skipped
      const aiDecision = await this.askAIAboutField(element, elementInfo, application, candidate);
      return aiDecision;
    }
    
    // Detect ambiguous buttons/links that need AI decision
    if (this.isClickableElement(elementInfo)) {
      const aiDecision = await this.askAIAboutClick(elementInfo, application, candidate);
      return aiDecision;
    }
    
    // Default to skip
    return { type: 'skip', reason: 'Unrecognized element type' };
  }

  /**
   * Detect mechanical actions that can be handled automatically
   */
  detectMechanicalAction(elementInfo) {
    const text = (elementInfo.text || '').toLowerCase();
    const id = (elementInfo.id || '').toLowerCase();
    const name = (elementInfo.name || '').toLowerCase();
    
    // File upload inputs
    if (elementInfo.tagName === 'input' && elementInfo.type === 'file') {
      return 'mechanical-file-upload';
    }
    
    // Apply buttons
    if (text.includes('apply') || text.includes('submit application') || 
        id.includes('apply') || name.includes('apply')) {
      return 'mechanical-apply-click';
    }
    
    // Next/continue buttons in multi-step forms
    if (text.includes('next') || text.includes('continue') || text.includes('proceed') ||
        id.includes('next') || name.includes('next')) {
      return 'mechanical-next-click';
    }
    
    // Submit buttons (only if form appears complete)
    if (text.includes('submit') && !text.includes('application') ||
        id.includes('submit') || name.includes('submit')) {
      return 'mechanical-submit-click';
    }
    
    // Skip/decline buttons
    if (text.includes('skip') || text.includes('decline') || text.includes('not applicable')) {
      return 'mechanical-skip-click';
    }
    
    return null; // Not a mechanical action
  }

  /**
   * Check if element is an input field
   */
  isInputField(elementInfo) {
    const inputTypes = ['text', 'email', 'tel', 'number', 'textarea', 'select'];
    return elementInfo.tagName === 'input' && inputTypes.includes(elementInfo.type) ||
           elementInfo.tagName === 'textarea' ||
           elementInfo.tagName === 'select';
  }

  /**
   * Check if element is clickable
   */
  isClickableElement(elementInfo) {
    return elementInfo.tagName === 'button' ||
           elementInfo.tagName === 'a' ||
           elementInfo.className?.includes('button') ||
           elementInfo.href !== '';
  }

  /**
   * Ask AI what to do with a form field
   */
  async askAIAboutField(element, elementInfo, application, candidate) {
    try {
      const options = await this.extractFieldOptions(element, elementInfo);
      
      const response = await this.api('answerField', {
        candidateId: application.candidateId,
        jobId: application.jobId,
        fieldInfo: {
          label: elementInfo.ariaLabel || elementInfo.placeholder || elementInfo.nearbyText || elementInfo.name,
          type: elementInfo.type,
          tagName: elementInfo.tagName,
          required: elementInfo.required || false,
          options: options,
          context: elementInfo.nearbyText
        }
      });
      
      if (response.needsHuman) {
        return { type: 'human-intervention', reason: 'AI requested human input' };
      }
      
      if (response.answer) {
        return { type: 'ai-fill', value: response.answer };
      }
      
      return { type: 'skip', reason: 'AI chose to skip field' };
    } catch (error) {
      console.error('AI field decision error:', error.message);
      return { type: 'skip', reason: 'AI decision failed' };
    }
  }

  /**
   * Extract options from select/radio/checkbox fields
   */
  async extractFieldOptions(element, elementInfo) {
    try {
      if (elementInfo.tagName === 'select') {
        const options = await element.locator('option').all();
        const optionData = [];
        for (const option of options) {
          const value = await option.getAttribute('value');
          const text = await option.textContent();
          if (value && text) {
            optionData.push({ value, text: text.trim() });
          }
        }
        return optionData;
      } else if (elementInfo.type === 'radio') {
        const name = elementInfo.name;
        if (!name) return [];
        
        const allRadios = await this.page.locator(`input[type="radio"][name="${name}"]`).all();
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
      } else if (elementInfo.type === 'checkbox') {
        const name = elementInfo.name;
        if (!name) return [];
        
        const allCheckboxes = await this.page.locator(`input[type="checkbox"][name="${name}"]`).all();
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
      
      return [];
    } catch (error) {
      console.error('Error extracting field options:', error.message);
      return [];
    }
  }

  /**
   * Ask AI whether to click an element
   */
  async askAIAboutClick(elementInfo, application, candidate) {
    try {
      const response = await this.api('decideClick', {
        candidateId: application.candidateId,
        jobId: application.jobId,
        currentUrl: this.page.url(),
        elementInfo: {
          text: elementInfo.text,
          id: elementInfo.id,
          name: elementInfo.name,
          href: elementInfo.href,
          context: elementInfo.nearbyText
        }
      });
      
      if (response.needsHuman) {
        return { type: 'human-intervention', reason: 'AI requested human decision' };
      }
      
      if (response.shouldClick) {
        return { type: 'ai-click', reason: response.reason };
      }
      
      return { type: 'skip', reason: response.reason || 'AI chose not to click' };
    } catch (error) {
      console.error('AI click decision error:', error.message);
      return { type: 'skip', reason: 'AI decision failed' };
    }
  }

  /**
   * Execute the decided action
   */
  async executeAction(element, action, application, candidate, elementInfo) {
    try {
      switch (action.type) {
        case 'mechanical-file-upload':
          // Already handled in handleFileUploads
          break;
          
        case 'mechanical-apply-click':
        case 'mechanical-next-click':
          await element.click();
          await this.page.waitForTimeout(500);
          break;
          
        case 'mechanical-submit-click':
          if (await this.isFormComplete()) {
            await element.click();
            this.formState.submitted = true;
          } else {
            console.log('Submit button found but form not complete, skipping');
          }
          break;
          
        case 'mechanical-skip-click':
          await element.click();
          break;
          
        case 'ai-fill':
          await this.fillField(element, action.value);
          this.formState.filledFields.push(action.value);
          break;
          
        case 'ai-click':
          await element.click();
          await this.page.waitForTimeout(500);
          break;
          
        case 'human-intervention':
          this.formState.humanInterventions.push({
            element: elementInfo,
            reason: action.reason
          });
          await this.requestHumanIntervention(application, action.reason);
          break;
          
        case 'skip':
          console.log(`Skipping element: ${action.reason}`);
          break;
      }
    } catch (error) {
      console.error(`Action execution error:`, error.message);
    }
  }

  /**
   * Fill a form field with the given value
   */
  async fillField(element, value) {
    const tagName = await element.evaluate(el => el.tagName.toLowerCase());
    const type = await element.getAttribute('type') || '';
    
    switch (tagName) {
      case 'select':
        await element.selectOption(value);
        break;
      case 'input':
        if (type === 'radio' || type === 'checkbox') {
          await element.check();
        } else {
          await element.fill(value);
        }
        break;
      case 'textarea':
        await element.fill(value);
        break;
      default:
        await element.fill(value);
    }
  }

  /**
   * Handle file uploads
   */
  async handleFileUploads(files) {
    if (!files) return;
    
    const fileInputs = await this.page.locator('input[type="file"]').all();
    
    for (const fileInput of fileInputs) {
      const name = await fileInput.getAttribute('name') || '';
      const id = await fileInput.getAttribute('id') || '';
      
      // Resume upload
      if (files.cv && (name.includes('resume') || id.includes('resume') || name.includes('cv'))) {
        await fileInput.setInputFiles(files.cv);
        console.log('Uploaded CV');
      }
      
      // Cover letter upload
      if (files.coverLetter && (name.includes('cover') || id.includes('cover') || name.includes('letter'))) {
        await fileInput.setInputFiles(files.coverLetter);
        console.log('Uploaded cover letter');
      }
    }
  }

  /**
   * Handle navigation in multi-step forms
   */
  async handleNavigation() {
    const currentUrl = this.page.url();
    
    if (currentUrl !== this.formState.initialUrl) {
      this.formState.currentStep++;
      console.log(`Navigation detected: step ${this.formState.currentStep}`);
      this.formState.visitedElements.clear(); // Reset for new page
    }
  }

  /**
   * Check if form is complete and ready for submission
   */
  async isFormComplete() {
    if (this.formState.submitted) return true;
    
    // Simple heuristic: if we've processed many elements and haven't hit navigation,
    // assume we're done
    return this.formState.visitedElements.size > 5 && this.formState.currentStep === 0;
  }

  /**
   * Request human intervention
   */
  async requestHumanIntervention(application, reason) {
    await this.api('captchaPause', {
      applicationId: application.applicationId,
      reason: 'HumanIntervention',
      notes: reason
    });
  }

  /**
   * Get unique identifier for an element
   */
  generateElementId(elementInfo) {
    return `${elementInfo.tagName}-${elementInfo.id || elementInfo.name || elementInfo.text?.substring(0, 20)}`;
  }

  /**
   * Build result object
   */
  buildResult() {
    return {
      system: 'unified-form-filler',
      stepsCompleted: this.formState.currentStep,
      fieldsFilled: this.formState.filledFields.length,
      fieldsSkipped: this.formState.skippedFields.length,
      humanInterventions: this.formState.humanInterventions.length,
      submitted: this.formState.submitted,
      filledFields: this.formState.filledFields,
      skippedFields: this.formState.skippedFields,
      interventions: this.formState.humanInterventions
    };
  }
}

/**
 * Main function that replaces the ATS-specific modules
 */
async function fillForm(page, application, files, candidate, api) {
  const filler = new UnifiedFormFiller(page, api);
  return await filler.fillApplication(application, files, candidate);
}

/**
 * Submit the form after human approval
 */
async function clickSubmit(page) {
  // Look for submit button with multiple strategies
  const submitStrategies = [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'input[type="submit"]',
    '[role="button"]:has-text("Submit")',
    '[role="button"]:has-text("Apply")'
  ];
  
  for (const strategy of submitStrategies) {
    try {
      const button = page.locator(strategy).first();
      if (await button.count() > 0) {
        await button.click();
        
        // Wait for submission confirmation
        await page.waitForSelector(
          'text=/application.*received|thank you|successfully submitted|your application has been sent/i',
          { timeout: 15000 }
        ).catch(() => {});
        
        return;
      }
    } catch (error) {
      // Try next strategy
    }
  }
  
  throw new Error('Could not find or click submit button');
}

module.exports = { fillForm, clickSubmit, UnifiedFormFiller };