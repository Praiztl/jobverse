/**
 * JOBVERSE MVP - FormBuilder.gs
 * Recreates the "Jobverse - Client Information Form" under this Google
 * account and points its responses at this Spreadsheet. Run once:
 * createJobverseForm(). It writes the new Form ID into Config > FORM_ID,
 * so run installFormTrigger() straight after.
 *
 * Field set = the client's original form + the BRD additions. The
 * application email/password pair is parsed by Intake.gs and written to
 * ApplicationEmail/ApplicationPassword on the Candidates row.
 */

function createJobverseForm() {
  var form = FormApp.create('JOBVERSE - CLIENT INFORMATION FORM');
  form.setDescription(
    'Please complete every field as accurately as possible. This information is used ' +
    'to prepare and submit job applications on your behalf.'
  );
  form.setCollectEmail(true);

  // ---- Original client fields ----
  form.addTextItem().setTitle('FULL NAME').setRequired(true);
  form.addTextItem().setTitle('MOBILE NUMBER (include country code)').setRequired(true);
  form.addTextItem().setTitle('EMAIL ADDRESS AND PASSWORD')
    .setHelpText('You are advised to create a new email solely for application purposes.')
    .setRequired(true);
  form.addParagraphTextItem().setTitle('FULL ADDRESS (street, city, town, post code, country)').setRequired(true);
  form.addMultipleChoiceItem().setTitle('MARITAL STATUS')
    .setChoiceValues(['Single', 'Married', 'Other']).setRequired(false);
  form.addTextItem().setTitle('NATIONALITY').setRequired(false);
  form.addMultipleChoiceItem().setTitle('GENDER')
    .setChoiceValues(['Male', 'Female']).setRequired(false);
  form.addDateItem().setTitle('DATE OF BIRTH').setRequired(false);
  form.addTextItem().setTitle('NOTICE PERIOD').setRequired(false);
  form.addTextItem().setTitle('SALARY EXPECTATIONS').setRequired(false);
  form.addTextItem().setTitle('PREFERRED JOB TITLES').setRequired(true);
  form.addTextItem().setTitle('PREFERRED WORK LOCATION(S)').setRequired(false);
  form.addCheckboxItem().setTitle('PREFERRED WORK MODEL (select all that apply)')
    .setChoiceValues(['Onsite', 'Hybrid', 'Remote']).setRequired(false);
  form.addTextItem().setTitle('VISA TYPE AND EXPIRY DATE (if applicable)').setRequired(false);
  form.addTextItem().setTitle('NATIONAL INSURANCE NUMBER (if applicable)').setRequired(false);
  form.addMultipleChoiceItem().setTitle("DO YOU HAVE A DRIVER'S LICENCE?")
    .setChoiceValues(['Yes', 'No']).setRequired(false);
  form.addMultipleChoiceItem().setTitle('DO YOU REQUIRE VISA SPONSORSHIP?')
    .setChoiceValues(['Yes', 'No']).setRequired(false);
  form.addParagraphTextItem()
    .setTitle('REFERENCE DETAILS COVERING THE PAST 3 YEARS OF EMPLOYMENT')
    .setHelpText('Full name, mobile number, email, job title, company name for each reference.')
    .setRequired(false);

  // ---- BRD additions ----
  form.addTextItem().setTitle('PREFERRED INDUSTRIES').setRequired(false);
  form.addTextItem().setTitle('PROFESSIONAL REGISTRATIONS (HCPC, NMC, GMC, SWE, etc.)').setRequired(false);
  form.addMultipleChoiceItem().setTitle('PREFERRED EMPLOYMENT TYPE')
    .setChoiceValues(['Permanent', 'Contract', 'Temporary']).setRequired(false);
  form.addTextItem().setTitle('LINKEDIN PROFILE').setRequired(false);
  form.addTextItem().setTitle('GITHUB').setRequired(false);
  form.addTextItem().setTitle('PORTFOLIO / WEBSITE').setRequired(false);

  // ---- Uploads ----
  // NOTE: FormApp.addFileUploadItem() only works for Google Workspace accounts.
  // On a personal Gmail account it throws "not a function", so these two
  // questions have to be added by hand in the Forms UI after this script runs.
  // See the alert below and README for the exact titles/settings to use.

  // Point responses at this Spreadsheet.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  setConfig('FORM_ID', form.getId());
  logActivity('system', 'form_created', 'form', form.getId(), form.getEditUrl());

  var msg = 'Form created. Edit: ' + form.getEditUrl() + ' | Live: ' + form.getPublishedUrl() +
    ' | Form ID saved to Config > FORM_ID. ' +
    'MANUAL STEP: open the edit URL and add two File upload questions - ' +
    '"PLEASE UPLOAD YOUR CV" (required) and "UPLOAD CERTIFICATES (if applicable)" (optional), ' +
    'max 5 files, 10MB each. Then run installFormTrigger().';
  Logger.log(msg);
  logActivity('system', 'form_created_details', 'form', form.getId(), msg);
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Form created - check Execution log or ActivityLog tab for the edit URL and next steps.',
      'Jobverse', 20
    );
  } catch (ignored) { /* toast is best-effort, never block on it */ }

  return { editUrl: form.getEditUrl(), liveUrl: form.getPublishedUrl(), id: form.getId() };
}