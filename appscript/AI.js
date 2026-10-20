/**
 * JOBVERSE MVP - AI.gs
 * Thin Anthropic Messages API client for Apps Script.
 * Key lives in Script Properties as ANTHROPIC_API_KEY, never in the sheet.
 */

function callClaude_(systemPrompt, userPrompt, maxTokens) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY in Script properties.');

  var payload = {
    model: getConfig_('ANTHROPIC_MODEL') || 'claude-sonnet-4-6',
    max_tokens: maxTokens || 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code === 429 || code >= 500) {
    Utilities.sleep(4000); // one retry on rate limit or server error
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    code = res.getResponseCode();
  }
  if (code !== 200) throw new Error('Anthropic API ' + code + ': ' + res.getContentText().slice(0, 500));

  var data = JSON.parse(res.getContentText());
  return data.content.filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('\n');
}

/** Ask for JSON and parse it defensively (strips code fences, finds outer braces). */
function callClaudeJSON_(systemPrompt, userPrompt, maxTokens) {
  var text = callClaude_(
    systemPrompt + '\nRespond with valid JSON only. No markdown, no commentary.',
    userPrompt, maxTokens
  );
  var clean = text.replace(/```json|```/g, '').trim();
  var start = clean.indexOf('{');
  var end = clean.lastIndexOf('}');
  if (start > -1 && end > start) clean = clean.slice(start, end + 1);
  return JSON.parse(clean);
}

function saveAIOutput_(agent, candidateId, jobId, outputObj) {
  var id = newId_('OUT');
  appendObject_('AIOutputs', {
    OutputID: id,
    CreatedAt: new Date(),
    Agent: agent,
    CandidateID: candidateId || '',
    JobID: jobId || '',
    Model: getConfig_('ANTHROPIC_MODEL'),
    OutputJSON: JSON.stringify(outputObj).slice(0, 45000)
  });
  return id;
}

function getTone_(name) {
  var rows = readRows_('ToneProfiles');
  var wanted = name || getConfig_('DEFAULT_TONE');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ProfileName === wanted) return rows[i].StyleInstructions;
  }
  return rows.length ? rows[0].StyleInstructions : 'British English, plain and professional.';
}