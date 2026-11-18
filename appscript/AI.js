/**
 * JOBVERSE MVP - AI.gs
 * Thin Anthropic Messages API client for Apps Script.
 * Key lives in Script Properties as ANTHROPIC_API_KEY, never in the sheet.
 */

/** The text of Claude's reply, given room for one longer try if it ran out of tokens. */
function callClaude_(systemPrompt, userPrompt, maxTokens) {
  var limit = maxTokens || 4000;
  var reply = claudeRequest_(systemPrompt, userPrompt, limit);
  if (reply.stop === 'max_tokens') reply = claudeRequest_(systemPrompt, userPrompt, Math.min(limit * 2, 16000));
  if (reply.stop === 'refusal') throw new Error('The AI declined this request.');
  if (reply.stop === 'max_tokens') throw new Error('The AI reply was too long to finish (limit ' + Math.min(limit * 2, 16000) + ' tokens).');
  return reply.text;
}

function claudeRequest_(systemPrompt, userPrompt, maxTokens) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY in Script properties.');

  var payload = {
    model: getConfig_('ANTHROPIC_MODEL') || 'claude-sonnet-4-6',
    max_tokens: maxTokens,
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
  if (code !== 200) {
    var body = res.getContentText();
    var outage = aiOutageReason_(code, body);
    if (outage) {
      // Every AI step will fail the same way until someone fixes the account: say so plainly, once, everywhere
      try { CacheService.getScriptCache().put('ai:down', JSON.stringify({ reason: outage, at: Date.now() }), 900); } catch (ignored) {}
      throw new Error('AI_UNAVAILABLE: ' + outage);
    }
    throw new Error('Anthropic API ' + code + ': ' + body.slice(0, 500));
  }
  try { if (CacheService.getScriptCache().get('ai:down')) CacheService.getScriptCache().remove('ai:down'); } catch (ignored) {}

  var data = JSON.parse(res.getContentText());
  return {
    stop: data.stop_reason,
    text: data.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n')
  };
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
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Sometimes two JSON objects come back one after the other (an answer, then a corrected
    // one): first-brace-to-last-brace then isn't valid JSON. Take the first complete object.
    var first = firstJsonObject_(clean);
    if (first) return JSON.parse(first);
    throw e;
  }
}

/** The first balanced {...} in text (braces inside strings ignored), or ''. */
function firstJsonObject_(text) {
  var s = String(text), depth = 0, inStr = false, esc = false, from = s.indexOf('{');
  if (from < 0) return '';
  for (var i = from; i < s.length; i++) {
    var ch = s.charAt(i);
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(from, i + 1);
  }
  return '';
}

/** Written once per form field or click: nothing reads them, so they stay out of the sheet unless debugging. */
var AI_STEP_AGENTS_ = { FieldAnswerer: true, ClickDecider: true, NextStepChooser: true };

function saveAIOutput_(agent, candidateId, jobId, outputObj) {
  if (AI_STEP_AGENTS_[agent] && String(getConfig_('LOG_AI_STEPS')).toLowerCase() !== 'on') return '';
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

/** A failure no retry will fix (no credit, bad key, disabled account): a plain-English reason, else ''. */
function aiOutageReason_(code, body) {
  var t = String(body || '');
  if (/credit balance is too low|billing|purchase credits/i.test(t)) return 'The Anthropic account behind Jobverse has run out of credit. An admin needs to top it up (console.anthropic.com > Billing) before the AI can answer again.';
  if (code === 401 || /authentication_error|invalid x-api-key/i.test(t)) return 'The Anthropic API key in Jobverse settings is not valid. An admin needs to update ANTHROPIC_API_KEY.';
  if (code === 403 || /permission_error/i.test(t)) return 'The Anthropic account behind Jobverse refused the request (permission). An admin needs to check the account.';
  return '';
}

/** The current AI outage, if one was seen in the last 15 minutes: { reason, at } or null. */
function aiOutage_() {
  try { var v = CacheService.getScriptCache().get('ai:down'); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
