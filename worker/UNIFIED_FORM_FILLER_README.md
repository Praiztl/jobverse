# Unified Form Filler System

A Playwright-based system that can fill any job application form by combining mechanical detection with AI-powered decision making.

## Overview

The unified form filler replaces the ATS-specific modules (greenhouse.js, workday.js) with a single, intelligent system that can handle any job application form regardless of the underlying ATS platform.

## Core Principles

1. **Mechanical Operations**: Handle predictable patterns automatically
   - Button detection (Apply, Next, Submit, Skip)
   - File upload detection and handling
   - Basic form navigation

2. **AI-Powered Decisions**: Ask AI for complex decisions
   - Field value determination based on candidate data
   - Ambiguous element interaction decisions
   - Context-aware navigation choices

3. **Human Intervention**: Detect and flag situations requiring human help
   - CAPTCHAs and anti-bot measures
   - Unusual form patterns
   - Fields that AI cannot confidently answer

4. **Progressive Enhancement**: Start with mechanical, fall back to AI, escalate to human
   - Maximize automation while maintaining safety
   - Reduce unnecessary AI API calls
   - Ensure human oversight for critical decisions

## Architecture

### Main Components

1. **UnifiedFormFiller Class**: Core orchestration engine
   - Manages form state and navigation
   - Coordinates mechanical and AI operations
   - Handles human intervention escalation

2. **Element Detection System**: Universal field identification
   - Detects all interactive elements (inputs, buttons, links)
   - Extracts comprehensive element metadata
   - Handles iframe-based forms (common in ATS systems)

3. **Decision Engine**: Action determination
   - Mechanical action detection for common patterns
   - AI-powered decisions for complex scenarios
   - Human intervention triggers for edge cases

4. **Action Execution**: Form manipulation
   - Field filling with proper type handling
   - Button clicking with timing considerations
   - Multi-step form navigation

## Key Features

### Universal Field Detection
- Detects all standard HTML form elements
- Handles dynamic JavaScript-rendered forms
- Works with iframe-embedded applications
- Extracts labels, placeholders, and context

### Mechanical Automation
- Automatic file upload handling (CV, cover letter)
- Apply button detection and clicking
- Next/Continue button navigation
- Submit button detection (only when form is complete)

### AI Integration
- Dynamic field value generation using existing AI system
- Context-aware click decisions
- Candidate data integration
- Job-specific customization

### Human Intervention
- CAPTCHA detection
- Unusual pattern recognition
- Required field escalation
- Manual override capabilities

### Multi-Step Form Support
- Automatic step detection
- Progress tracking
- State preservation across navigation
- Completion detection

## API Integration

### New API Endpoints

#### `decideClick`
Called when the system needs AI help deciding whether to click a button/link.

**Request:**
```json
{
  "action": "decideClick",
  "candidateId": "string",
  "jobId": "string",
  "currentUrl": "string",
  "elementInfo": {
    "text": "string",
    "id": "string", 
    "name": "string",
    "href": "string",
    "context": "string"
  }
}
```

**Response:**
```json
{
  "shouldClick": boolean,
  "reason": "string",
  "needsHuman": boolean
}
```

### Existing API Endpoints (Enhanced)

#### `answerField`
Enhanced to support the unified system's universal field detection.

**Enhanced Request:**
```json
{
  "action": "answerField",
  "candidateId": "string",
  "jobId": "string",
  "fieldInfo": {
    "label": "string",
    "type": "string",
    "tagName": "string",
    "required": boolean,
    "options": [
      { "value": "string", "text": "string" }
    ],
    "context": "string"
  }
}
```

## Usage

### Basic Usage

```javascript
const { fillForm, clickSubmit } = require('./unified-form-filler');

// Fill a form (pass 1 - for review)
const snapshot = await fillForm(page, application, files, candidate, api);

// Submit after human approval (pass 2)
await clickSubmit(page);
```

### Advanced Usage

```javascript
const { UnifiedFormFiller } = require('./unified-form-filler');

const filler = new UnifiedFormFiller(page, api);
const result = await filler.fillApplication(application, files, candidate);

console.log(`Filled ${result.fieldsFilled} fields`);
console.log(`Skipped ${result.fieldsSkipped} fields`);
console.log(`Required ${result.humanInterventions.length} human interventions`);
```

## Configuration

### Environment Variables

The system uses the existing worker configuration:

- `JOBVERSE_API_URL`: API endpoint for AI decisions
- `JOBVERSE_API_TOKEN`: Authentication token
- `HEADED`: Run with visible browser (debugging)
- `DOWNLOAD_DIR`: Directory for downloaded files

### Customization

You can extend the system by:

1. **Adding mechanical patterns**: Modify `detectMechanicalAction()`
2. **Enhancing AI prompts**: Update API endpoint prompts
3. **Adding field types**: Extend `isInputField()` and extraction logic
4. **Custom navigation**: Modify `handleNavigation()`

## Migration from ATS-Specific Modules

### Before (ATS-specific)
```javascript
const ats = {
  greenhouse: require('./ats/greenhouse'),
  workday: require('./ats/workday'),
};

const module = moduleFor(prospect.ats);
if (!module) {
  // Handle unsupported ATS
}

await module.fillForm(page, application, files, candidate, api);
```

### After (Unified)
```javascript
const unifiedFormFiller = require('./unified-form-filler');

// No ATS-specific logic needed
await unifiedFormFiller.fillForm(page, application, files, candidate, api);
```

## Benefits

1. **Universal Support**: Works with any ATS platform without custom code
2. **Reduced Maintenance**: Single codebase instead of per-ATS modules
3. **Better Adaptability**: AI handles platform-specific variations
4. **Progressive Enhancement**: Mechanical actions reduce AI costs
5. **Safety**: Human intervention for critical decisions
6. **Scalability**: Easy to add new patterns and capabilities

## Limitations and Future Enhancements

### Current Limitations
- Basic completion detection (heuristics-based)
- Limited CAPTCHA handling (escapes to human)
- Simple multi-step form support
- Basic error recovery

### Planned Enhancements
- Machine learning for mechanical pattern detection
- Advanced CAPTCHA solving integration
- Visual form analysis
- Cross-platform form state persistence
- Retry logic with exponential backoff
- Performance metrics and optimization

## Testing

### Manual Testing
1. Test on different ATS platforms (Greenhouse, Workday, Lever, etc.)
2. Test various form types (simple, multi-step, conditional)
3. Test edge cases (CAPTCHAs, unusual fields, dynamic forms)
4. Test file upload handling
5. Test human intervention flows

### Automated Testing
```bash
# Run worker in headed mode for debugging
HEADED=true node worker.js
```

## Troubleshooting

### Common Issues

**Form not completing:**
- Check form completion detection logic
- Review AI decision logs
- Verify mechanical button detection

**Excessive human interventions:**
- Review AI prompts for clarity
- Add more mechanical patterns
- Improve element context extraction

**Performance issues:**
- Reduce element detection scope
- Add caching for repeated operations
- Optimize AI API calls

## Debugging

Enable detailed logging:

```javascript
const filler = new UnifiedFormFiller(page, api);
// Add console.log statements in key methods
```

Use headed mode to watch the process:

```bash
HEADED=true node worker.js
```

## Security Considerations

1. **Candidate Data**: All candidate data flows through existing secure API
2. **API Security**: Uses existing token-based authentication
3. **File Handling**: Secure file upload with validation
4. **Human Intervention**: Ensures human oversight for critical decisions

## Performance

### Optimization Tips
- Mechanical actions reduce AI API calls
- Element caching prevents re-detection
- Parallel element processing where possible
- Efficient state management

### Metrics to Monitor
- Fields filled vs. AI calls
- Human intervention rate
- Form completion time
- Error rates by ATS platform

## Contributing

When extending the system:

1. Add mechanical patterns before AI solutions
2. Test across multiple ATS platforms
3. Update documentation for new features
4. Add error handling for edge cases
5. Consider performance implications

## License

Part of the Jobverse project. See main project license for details.