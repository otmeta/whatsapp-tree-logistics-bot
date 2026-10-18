const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const { MessagingResponse } = require('twilio').twiml;
require('dotenv').config();

// Import services
const clients = require('./services/clients');
const conversationFlow = require('./services/conversationFlow');
const googleSheets = require('./services/googleSheets');
const messaging = require('./services/messaging');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '2.3.0-driver-commands';

// Reject webhooks that Twilio did not sign. Off by default: the signed URL has
// to be rebuilt exactly as Twilio saw it, and behind Railway's proxy a wrong
// guess would reject every real driver. Every request is checked and the verdict
// logged as [SIGCHECK], so the logs prove it is safe before this is switched on.
const ENFORCE_SIGNATURE = process.env.TWILIO_VALIDATE_SIGNATURE === 'true';

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Drivers are explicitly asked to send their IBAN, so keep it out of routine
// logs. The REQUEST_NOT_SAVED recovery line still carries the untouched text,
// because that only fires when a request would otherwise be lost for good.
function maskIban(text) {
  return String(text == null ? '' : text).replace(
    /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?\d{1,3})?\b/gi,
    (match) => {
      const compact = match.replace(/\s/g, '');
      const digits = (compact.match(/\d/g) || []).length;
      // Real IBANs are 15-34 characters and mostly digits. Anything else that
      // happens to fit the shape is ordinary prose, so leave it readable.
      return compact.length >= 15 && compact.length <= 34 && digits >= 8
        ? '[IBAN redacted]'
        : match;
    }
  );
}

// Some endpoints can WhatsApp every driver, rewrite the whole Status column, or
// list every phone number, and they sit on a public URL. Setting ADMIN_SECRET
// turns them into shared-secret endpoints. Left unset they behave exactly as
// before, so nothing that calls them today breaks until you opt in.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return next();

  const provided = req.headers['x-admin-secret'] || req.query.secret ||
    (req.body && req.body.secret) || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);

  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();

  console.warn(`⚠️ Blocked unauthenticated admin call to ${req.originalUrl}`);
  return res.status(403).json({ success: false, error: 'Forbidden' });
}

// Rebuild the URL Twilio signed and check the signature against it.
function verifyTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];

  if (!authToken) return { checked: false, reason: 'no_auth_token' };
  if (!signature) return { checked: true, valid: false, reason: 'missing_signature' };

  // Railway terminates TLS, so req.protocol/host describe the internal hop.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;

  try {
    const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
    return { checked: true, valid, reason: valid ? 'ok' : 'mismatch', url };
  } catch (error) {
    return { checked: true, valid: false, reason: `error:${error.message}`, url };
  }
}

// Simple message handler - collects all info in one message
const COMMANDS = `
You can reply:
• HELP — show this
• CANCEL — stop, nothing is sent
• START OVER — begin again`;

function commandOf(message) {
  const core = String(message || '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (/^(help|hilfe|info)$/.test(core)) return 'help';
  if (/^(cancel|quit|stop|abbrechen)$/.test(core)) return 'cancel';
  if (/^(start over|startover|restart|reset|von vorn|nochmal)$/.test(core)) return 'start_over';
  return null;
}

function helpMessage(flowState) {
  if (!flowState) {
    return `🌳 Tree Logistics Office Support

Tell us your first name, last name, and where you work.
For example: John Smith DBE2   or   Maria Garcia Berlin
${COMMANDS}`;
  }

  if (flowState.step === 'voi_city') {
    return `We're waiting for the city you work in.

For example: Berlin, Hamburg, Kiel
${COMMANDS}`;
  }

  if (flowState.step === 'request_collection') {
    return `We're waiting for what you need help with. The more detail you give, the faster the office can act.
${COMMANDS}`;
  }

  return `We're waiting for your first name, last name, and where you work.
For example: John Smith DBE2   or   Maria Garcia Berlin
${COMMANDS}`;
}

async function handleMessage(body, from, profileName) {
  const message = body.trim();
  
  console.log(`📱 Received from ${from}: "${maskIban(message)}"`);
  
  const flowState = conversationFlow.getFlowState(from);
  const command = commandOf(message);

  if (command === 'help') {
    if (flowState) conversationFlow.updateFlow(from, {});
    return helpMessage(flowState);
  }

  if (command === 'cancel') {
    conversationFlow.clearFlow(from);
    return `Okay, we've stopped. Nothing was sent to the office.

Send a message whenever you want to start again.`;
  }

  if (command === 'start_over') {
    conversationFlow.clearFlow(from);
    return await startDataCollectionFlow(from, profileName, '');
  }

  if (flowState) {
    return await handleActiveFlow(flowState, message, from, profileName);
  }

  return await startDataCollectionFlow(from, profileName, message);
}

// Openers that carry no request of their own — treating one of these as the
// driver's request would put "Hallo" in the sheet instead of what they need.
const GREETING_ONLY = /^(hi+|hey+|hello+|hallo+|halo|guten\s+(tag|morgen|abend)|moin|servus|good\s+(morning|afternoon|evening|day)|salam|salaam|assalamu\s*alaikum|merhaba|ola|bom\s+dia|boa\s+tarde|bonjour|ciao|salut|namaste|start|help|hilfe|info|test|ok|okay|thanks|thank\s+you|danke|guten\s+tag\s+team)$/i;

// Does this message look like an actual request, rather than a greeting or the
// driver's name and station?
function looksLikeRequest(message) {
  const text = (message || '').trim();

  if (text.length < 15) return false;

  // Compare against the greeting list with punctuation and emoji stripped, so
  // "Hallo!! 👋" is still recognised as a greeting.
  const core = text.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (GREETING_ONLY.test(core)) return false;

  // Name + station is identification, not a request.
  if (parseDriverInfo(text).isValid) return false;

  return text.split(/\s+/).filter(Boolean).length >= 3;
}

// Start data collection flow - asks for all 3 pieces of info at once
async function startDataCollectionFlow(from, profileName, firstMessage) {
  // A driver who opens with their actual request must not have to type it a
  // second time — hold it and submit it the moment we know who they are.
  // This is also what saves a request sent while the bot was restarting, since
  // a restart wipes the in-memory flow and lands the driver back here.
  const pendingRequest = looksLikeRequest(firstMessage) ? firstMessage.trim() : null;

  conversationFlow.startFlow(from, {
    step: 'data_collection',
    profileName: profileName,
    flow: 'data_collection',
    pendingRequest: pendingRequest
  });

  if (pendingRequest) {
    console.log(`📌 Holding opening request from ${from} until they identify themselves`);

    return `🌳 Welcome to Tree Logistics Office Support!

We have your message and it is safe — we just need to know who you are before we send it to the office.

Please reply with your first name, last name, and where you work.

For example: John Smith DBE2   or   Maria Garcia Berlin
${COMMANDS}`;
  }

  return `🌳 Welcome to Tree Logistics Office Support!

We are glad that you reached out! To get started, please tell us your first name, last name, and where you work.

📝 For example: John Smith DBE2   or   Maria Garcia Berlin
${COMMANDS}`;
}

// Handle data collection - parse the single message for all 3 pieces of info
async function handleDataCollection(message, from, data) {
  try {
    // Parse the message to extract the 3 pieces of information
    const parsedData = parseDriverInfo(message);
    
    if (!parsedData.isValid) {
      // VOI told us who they are but not where. Hold the name and ask only for
      // the city, rather than making them type everything again.
      if (parsedData.error === 'voi_city_missing') {
        conversationFlow.updateFlow(from, {
          ...data,
          client: 'voi',
          firstName: parsedData.firstName,
          lastName: parsedData.lastName,
          step: 'voi_city'
        });

        return `📝 Thanks! Which city do you work in?

For example: ${clients.VOI_CITIES.slice(0, 4).join(', ')}`;
      }

      if (parsedData.error === 'station_unclear') {
        return `📝 Sorry, we could not read your station.

Please send your name together with *DBE2* or *DBE3*, for example:
John Smith DBE2`;
      }

      // Say which piece is missing — "wrong format" alone leaves drivers guessing.
      if (parsedData.error === 'name_incomplete') {
        return `📝 Thanks! We also need your last name.

Please send your first name, last name and where you work together, for example:
John Smith DBE2   —   or   —   Maria Garcia Berlin`;
      }

      return `📝 We still need to know where you work, so your request reaches the right team.

Please send it together with your name — your station or your city:
John Smith DBE2   —   or   —   Maria Garcia Berlin`;
    }

    // Now ask for their request/question
    conversationFlow.updateFlow(from, {
      ...data,
      firstName: parsedData.firstName,
      lastName: parsedData.lastName,
      station: parsedData.station,
      step: 'request_collection'
    });

    // They already told us what they need before identifying themselves — submit
    // it now rather than asking them to type it again.
    if (data.pendingRequest) {
      console.log(`📌 Submitting held request for ${parsedData.firstName} ${parsedData.lastName}`);

      const { step, ...identified } = conversationFlow.getFlowState(from) || {};
      return await handleRequestCollection(data.pendingRequest, from, identified);
    }

    return requestPrompt(parsedData.firstName, parsedData.lastName, parsedData.station, parsedData.client);
    
  } catch (error) {
    console.error('Error parsing driver info:', error);
    return `❌ Please provide the information in the correct format:

📝 **First Name**
📝 **Last Name**
🏢 **Station** (DBE3 or DBE2)

Please try again.`;
  }
}

/** The "what do you need?" message, with the examples for that contract. */
function requestPrompt(firstName, lastName, station, clientKey) {
  const config = clients.clientConfig(clientKey);

  return `---------
✅ Perfect! ${firstName} ${lastName}, from ${station} 📍

Now, please tell us what you need help with. 

📝 The more details you provide, the faster we can help you!

Examples:
${config.examples.map(function (e) { return '• "' + e + '"'; }).join('\n')}

💡 ${config.closing}

What can we help you with?
---------`;
}

/**
 * Second step for VOI drivers who gave a name but no city. Only the city is
 * expected here, so a bare "Berlin" is enough.
 */
async function handleVoiCity(message, from, data) {
  const words = String(message || '').trim().split(/\s+/).filter(Boolean);

  // Some drivers answer "VOI Berlin" again rather than just the city.
  const cityWord = words.find(function (word) {
    return !clients.isVoiToken(word) && /^\p{L}[\p{L}\-']*$/u.test(word);
  });

  if (!cityWord) {
    return `📝 Sorry, we did not catch the city.

Which city do you work in? For example: ${clients.VOI_CITIES.slice(0, 4).join(', ')}`;
  }

  const city = clients.canonicalCity(cityWord);
  const station = 'VOI ' + city;

  conversationFlow.updateFlow(from, {
    ...data,
    station: station,
    client: 'voi',
    step: 'request_collection'
  });

  if (data.pendingRequest) {
    console.log(`📌 Submitting held request for ${data.firstName} ${data.lastName} (${station})`);
    const { step, ...identified } = conversationFlow.getFlowState(from) || {};
    return await handleRequestCollection(data.pendingRequest, from, identified);
  }

  return requestPrompt(data.firstName, data.lastName, station, 'voi');
}

/**
 * Parse driver information from a single message.
 *
 * Handles both contracts: "John Smith DBE2" for Amazon and "John Smith VOI Berlin"
 * for VOI. Drivers write the station before, after and in the middle of their
 * name, so it is found wherever it is — taking only the words before it used to
 * drop the surname of anyone who wrote "Luis DBE3 Ferreira".
 */
function parseDriverInfo(message) {
  const words = (message || '').trim().split(/\s+/).filter(Boolean);

  const detected = clients.detectClient(words);
  if (!detected) {
    return { isValid: false, error: 'station_missing' };
  }

  // They reached for a station but we could not read it. Say so, rather than
  // repeating the generic prompt or guessing the other contract.
  if (detected.unclearStation) {
    return { isValid: false, error: 'station_unclear' };
  }

  const nameWords = words.filter(function (_, index) {
    return detected.usedIndexes.indexOf(index) === -1;
  });

  // VOI without a city: keep the name so we only have to ask for the city.
  if (detected.needsCity) {
    return {
      isValid: false,
      error: 'voi_city_missing',
      client: 'voi',
      firstName: nameWords[0] || '',
      lastName: nameWords.slice(1).join(' ')
    };
  }

  if (nameWords.length < 2) {
    return { isValid: false, error: 'name_incomplete', client: detected.client };
  }

  return {
    isValid: true,
    firstName: nameWords[0],
    lastName: nameWords.slice(1).join(' '),
    station: detected.station,
    client: detected.client,
    location: detected.location
  };
}

// Detect request type and provide contextual help
function detectRequestType(requestText) {
  const text = requestText.trim().toLowerCase();
  
  console.log(`[DETECT] Analyzing text: "${maskIban(text)}"`);
  
  // IBAN/Bank account change
  if (/\b(iban|bank\s+account|account\s+number|change\s+iban|update\s+iban|new\s+iban)\b/i.test(text)) {
    console.log(`[DETECT] Detected: iban_change`);
    return 'iban_change';
  }
  
  // Scanner request - check for scanner keywords (must check before equipment to avoid false positives)
  // Match: "scanner", "need scanner", "want scanner", "new scanner", "scanner broken", etc.
  if (/\b(scanner|scanning\s+device|scan\s+device)\b/i.test(text) || 
      /\b(need|want|get|new)\s+(a\s+)?scanner\b/i.test(text) ||
      /\bscanner\s+(broken|not\s+working|doesn't\s+work)\b/i.test(text)) {
    console.log(`[DETECT] Detected: scanner`);
    return 'scanner';
  }
  
  // Vacation/Time off request
  if (/\b(vacation|holiday|time\s+off|days\s+off|leave|off\s+work|free\s+days|need\s+vacation|want\s+vacation)\b/i.test(text)) {
    console.log(`[DETECT] Detected: vacation`);
    return 'vacation';
  }
  
  // Equipment request
  if (/\b(equipment|device|tool|machine|need\s+new|broken|not\s+working)\b/i.test(text)) {
    console.log(`[DETECT] Detected: equipment`);
    return 'equipment';
  }
  
  console.log(`[DETECT] Detected: general`);
  return 'general';
}

// What counts as a broken item, in the driver's own words.
const BROKEN_PATTERN = /\b(broken|not\s+working|doesn't\s+work|stopped|dead|faulty|defective|doesn't\s+turn\s+on|won't\s+work)\b/i;

// Validate request text - contextual and helpful validation
function validateRequestText(requestText, retryCount = 0, clientKey = 'amazon') {
  const clientConfig = clients.clientConfig(clientKey);
  const text = requestText.trim();
  const textLower = text.toLowerCase();
  const words = text.split(/\s+/).filter(word => word.length > 0);
  
  console.log(`[VALIDATION] Validating: "${maskIban(text)}" (retry: ${retryCount})`);
  
  // After 1 retry, accept the request anyway (don't frustrate users)
  const MAX_RETRIES = 1;
  if (retryCount >= MAX_RETRIES) {
    console.log(`[VALIDATION] Max retries reached, accepting request`);

    // Accepting early used to skip type detection entirely, so a driver whose
    // second message was "it is broken" got a confirmation with no idea how to
    // get a replacement. Still attach the instruction when the answer makes it
    // clear something is broken.
    const type = detectRequestType(text);
    const isEquipment = type === 'scanner' || type === 'equipment';

    return {
      isValid: true,
      warning: true,
      message: null,
      helpfulInfo: isEquipment && BROKEN_PATTERN.test(text)
        ? clientConfig.replacementInstruction
        : undefined
    };
  }

  // Very short requests (less than 10 characters) - definitely too short
  if (text.length < 10) {
    return {
      isValid: false,
      reason: 'too_short',
      message: `📝 Your message is very short. Could you add a bit more detail?\n\nWhat can we help you with?`
    };
  }

  // Detect request type for contextual help
  const requestType = detectRequestType(text);
  console.log(`[VALIDATION] Request type detected: ${requestType}`);
  
  // IBAN Change - ask for IBAN number if not already provided (only on first attempt)
  if (requestType === 'iban_change') {
    const ibanPattern = /\b(DE|de)\s*\d{2}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{2}\b|\bDE\d{20}\b/i;
    if (!ibanPattern.test(text)) {
      console.log(`[VALIDATION] IBAN request without IBAN number, asking once`);
      return {
        isValid: false,
        reason: 'iban_missing',
        message: `📝 To update your IBAN, please also send your new IBAN number.\n\nExample: DE12 5001 0517 0648 4898 90\n\nWhat's your new IBAN? (or send any message again to save your request as-is)`
      };
    }
  }
  
  // Scanner Request - ask if it still works (only on first attempt)
  if (requestType === 'scanner') {
    console.log(`[VALIDATION] Scanner request detected, checking status...`);
    const workingPattern = /\b(working|works|fine|ok|okay|good|still\s+works)\b/i;

    const isBroken = BROKEN_PATTERN.test(text);
    const isWorking = workingPattern.test(text);
    
    console.log(`[VALIDATION] Scanner - isBroken: ${isBroken}, isWorking: ${isWorking}`);
    
    // If broken, provide helpful info and accept immediately
    if (isBroken) {
      console.log(`[VALIDATION] ✅ Scanner is broken, accepting with helpful info`);
      return {
        isValid: true,
        requestType: 'scanner',
        helpfulInfo: clientConfig.replacementInstruction
      };
    }
    
    // If status unclear, ask once - on next message it will be saved (MAX_RETRIES=1)
    if (!isWorking) {
      console.log(`[VALIDATION] Scanner status unclear, asking once`);
      return {
        isValid: false,
        reason: 'scanner_status',
        message: `📝 Is your scanner still working, or is it broken?\n\nIf it's broken: ${clientConfig.replacementInstruction}\n\nIf it's still working: Let us know what the issue is and we'll help you.\n\n(Send any message again to save your request as-is)`
      };
    }
    
    console.log(`[VALIDATION] ✅ Scanner request accepted`);
  }
  
  // Vacation Request - ask for dates (only on first attempt)
  if (requestType === 'vacation') {
    console.log(`[VALIDATION] Vacation request detected, checking for dates...`);
    const datePattern = /\b(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}|\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)|next\s+week|this\s+week|from\s+\d|to\s+\d|until|till|from\s+\d{1,2}|december|january|february|march|april|may|june|july|august|september|october|november)\b/i;
    const fromToPattern = /\b(from|starting|beginning)\s+.+\s+(to|until|till|ending)\s+/i;
    
    const hasDates = datePattern.test(text) || fromToPattern.test(text);
    console.log(`[VALIDATION] Has dates: ${hasDates}`);
    
    if (!hasDates) {
      console.log(`[VALIDATION] Vacation without dates, asking once`);
      return {
        isValid: false,
        reason: 'vacation_dates',
        message: `📝 To help with your vacation request, please include the dates.\n\nExample:\n• "I need vacation from 15.03.2026 to 22.03.2026"\n• "I need 5 days off starting next Monday"\n\nWhich dates do you need? (or send any message again to save your request as-is)`
      };
    }
    console.log(`[VALIDATION] ✅ Vacation request accepted`);
  }

  // Check for extremely vague phrases with no context (only if not a specific request type)
  if (requestType === 'general') {
    const extremelyVague = [
      { pattern: /^(i have|i've got|there is|there's)\s+(a\s+)?problem\.?$/i, example: 'I have a problem with my scanner - it stopped working yesterday' },
      { pattern: /^(i need|i want)\s+help\.?$/i, example: 'I need help changing my IBAN number' },
      { pattern: /^(i have|i've got)\s+(an\s+)?issue\.?$/i, example: 'I have an issue with my delivery route - it shows the wrong address' },
      { pattern: /^something\s+(is\s+)?wrong\.?$/i, example: "Something is wrong with my scanner - it won't turn on" }
    ];

    for (const vague of extremelyVague) {
      if (vague.pattern.test(textLower)) {
        return {
          isValid: false,
          reason: 'too_vague',
          message: `📝 Could you tell us a bit more? \n\nFor example: "${vague.example}"\n\nWhat exactly do you need help with?`
        };
      }
    }
  }

  // Request is valid
  console.log(`[VALIDATION] ✅ All validations passed, request is valid`);
  return {
    isValid: true,
    requestType: requestType
  };
}

// Handle request collection - get the actual request/question
async function handleRequestCollection(message, from, data) {
  try {
    const requestText = message.trim();
    
    // Get retry count from flow state (how many times they've tried)
    const retryCount = data.requestRetryCount || 0;
    
    console.log(`\n========== REQUEST VALIDATION START ==========`);
    console.log(`📱 User: ${data.firstName} ${data.lastName} (${from})`);
    console.log(`📝 Request text: "${maskIban(requestText)}"`);
    console.log(`🔄 Retry count: ${retryCount}`);
    
    // Validate the request text (contextual and helpful validation)
    // Which contract this driver is on decides how a replacement is arranged.
    const clientKey = data.client || clients.clientOfStation(data.station) || 'amazon';
    const validation = validateRequestText(requestText, retryCount, clientKey);
    
    console.log(`🔍 Validation result:`, JSON.stringify(validation, null, 2));
    
    // CRITICAL: Always check validation.isValid - never bypass this check
    if (validation === null || validation === undefined || !validation.isValid) {
      console.log(`❌ VALIDATION FAILED - Request will NOT be saved`);
      console.log(`📤 Returning message to user asking for more info`);
      console.log(`========== REQUEST VALIDATION END ==========\n`);
      
      // Store the original request text and increment retry count
      conversationFlow.updateFlow(from, {
        ...data,
        requestRetryCount: retryCount + 1,
        originalRequest: data.originalRequest || requestText  // Save the first message
      });
      
      // Return contextual, helpful message
      return validation.message;
    }
    
    console.log(`✅ VALIDATION PASSED - Request will be saved to Google Sheets`);
    console.log(`========== REQUEST VALIDATION END ==========\n`);

    // DOUBLE CHECK: Ensure validation actually passed (safety check)
    if (!validation || !validation.isValid) {
      console.error(`🚨 CRITICAL ERROR: Validation says invalid but code reached save point!`);
      console.error(`Validation object:`, validation);
      return `⚠️ There was an error processing your request. Please try again.`;
    }

    // Combine original request + follow-up if this is a retry
    let fullRequestText = requestText;
    if (data.originalRequest && data.originalRequest !== requestText) {
      fullRequestText = `${data.originalRequest} | ${requestText}`;
      console.log(`📝 Combined request: "${maskIban(fullRequestText)}"`);
    }

    // Request is valid - save it
    const saveResult = await saveRequest(from, data, fullRequestText);
    
    // Clear the flow only if save was successful
    conversationFlow.clearFlow(from);
    
    const requestId = saveResult?.rowId || `REQ-${Date.now()}`;
    const fullName = `${data.firstName} ${data.lastName}`;
    
    // Add helpful info based on request type (e.g., scanner replacement instructions)
    let helpfulInfo = '';
    if (validation.helpfulInfo) {
      helpfulInfo = `\n\n💡 ${validation.helpfulInfo}`;
    }
    
    // If they had retries, acknowledge their persistence
    const retryAcknowledgment = retryCount > 0 
      ? '\n\nThanks for providing the details!' 
      : '';
    
    return `💚 Thank you ${fullName}! Your request has been submitted successfully and our team will review it and contact you soon. Have a great day!${helpfulInfo}${retryAcknowledgment}

🆔 Request ID: ${requestId}`;
  } catch (error) {
    // Log the error but don't clear the flow so user can try again
    console.error('❌ Failed to save request:', error);
    
    const fullName = `${data.firstName} ${data.lastName}`;
    return `⚠️ We're sorry ${fullName} — your request could NOT be saved and has not reached our team.

Please send your request again in a moment. You will get a Request ID once it is saved successfully.

If it fails again, please contact the office directly so your request is not lost.`;
  }
}

// Updated handleActiveFlow to handle request collection
async function handleActiveFlow(flowState, message, from, profileName) {
  const { step, ...data } = flowState;

  console.log(`📱 Active flow for ${from}: step=${step}, identified=${!!data.firstName}`);

  if (step === 'data_collection') {
    return await handleDataCollection(message, from, data);
  }

  if (step === 'voi_city') {
    return await handleVoiCity(message, from, data);
  }

  if (step === 'request_collection') {
    return await handleRequestCollection(message, from, data);
  }

  return await startDataCollectionFlow(from, profileName, message);
}

// Save request to Google Sheets with only the 4 required fields
async function saveRequest(from, data, requestText) {
  const timestamp = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  
  try {
    console.log(`📝 Attempting to save request to Google Sheets for ${data.firstName} ${data.lastName} from ${data.station}`);
    
    const result = await googleSheets.addRequest({
      timestamp: timestamp,
      firstName: data.firstName,
      lastName: data.lastName,
      phoneNumber: from,
      station: data.station,
      request: requestText,
      status: 'To be contacted',
      rowId: `REQ-${Date.now()}`,
    });
    
    // addRequest throws unless the row was written AND read back, so reaching
    // this point means the request is genuinely in the sheet.
    console.log(`✅ Request ${result.rowId} verified in Google Sheets at row ${result.row}`);
    return { success: true, rowId: result.rowId };
  } catch (error) {
    console.error('❌ Google Sheets Error - Failed to save request:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    // Check for specific error types
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error('❌ Network error - cannot reach Google Sheets API');
    } else if (error.code === 401 || error.message.includes('authentication')) {
      console.error('❌ Authentication error - check Google credentials');
    } else if (error.code === 403 || error.message.includes('permission')) {
      console.error('❌ Permission error - service account may not have access to the sheet');
    } else if (error.code === 404 || error.message.includes('not found')) {
      console.error('❌ Sheet not found - check spreadsheet ID and sheet name');
    }
    
    // Re-throw the error so the caller can handle it
    throw error;
  }
}

// WhatsApp webhook endpoint - GET for verification
app.get('/webhook/whatsapp', (req, res) => {
  console.log('🔍 Webhook verification request (GET)');
  res.json({ 
    status: 'webhook endpoint active',
    method: 'POST to receive messages',
    timestamp: new Date().toISOString()
  });
});

// WhatsApp webhook endpoint - POST for messages
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    // Twilio sends form-encoded data with capitalized field names
    const body = req.body.Body || req.body.body || '';
    const from = req.body.From || req.body.from;
    const profileName = req.body.ProfileName || req.body.profileName || 'User';
    const messageSid = req.body.MessageSid || req.body.SmsMessageSid || 'no-sid';

    // The old handler dumped every header and the whole body, which put driver
    // IBANs into the logs several times per message. One compact line instead.
    console.log(`📥 Webhook ${messageSid} from ${from || 'unknown'} (${profileName}), ${body.length} chars`);

    const signature = verifyTwilioSignature(req);
    if (signature.checked && !signature.valid) {
      console.warn(`⚠️ [SIGCHECK] REJECTED-${signature.reason} url=${signature.url || req.originalUrl} enforcing=${ENFORCE_SIGNATURE}`);
      if (ENFORCE_SIGNATURE) {
        return res.status(403).send('Invalid Twilio signature');
      }
    } else if (signature.checked) {
      console.log('✅ [SIGCHECK] OK');
    }

    if (!body || !from) {
      console.error('❌ Missing required parameters:', { body: !!body, from: !!from });
      return res.status(400).send('Missing required parameters');
    }
    
    const responseMessage = await handleMessage(body, from, profileName);
    
    const twiml = new MessagingResponse();
    twiml.message(responseMessage);

    console.log(`✅ Replied to ${messageSid} (${responseMessage.length} chars)`);

    res.writeHead(200, { 
      'Content-Type': 'text/xml; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(twiml.toString());

  } catch (error) {
    console.error('❌ Webhook Error:', error);
    console.error('Error stack:', error.stack);
    
    const twiml = new MessagingResponse();
    twiml.message('Sorry, there was an error processing your request. Please try again.');
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    service: 'Tree Logistics WhatsApp Bot',
    status: 'running',
    endpoints: {
      webhook: 'POST /webhook/whatsapp',
      health: 'GET /health',
      test: 'POST /test',
      clearFlows: 'POST /clear-flows',
      normalizeStatuses: 'POST /normalize-statuses',
      fixCompletedStatuses: 'POST /fix-completed-statuses',
      forceFixAllStatuses: 'POST /force-fix-all-statuses',
      statusDiagnostics: 'GET /status-diagnostics',
      broadcast: 'POST /broadcast',
      broadcastRecipients: 'GET /broadcast/recipients'
    },
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    version: VERSION,
    signatureEnforced: ENFORCE_SIGNATURE,
    activeFlows: conversationFlow.getActiveFlowsCount(),
    timestamp: new Date().toISOString()
  });
});

// Simple test endpoint
app.post('/test', (req, res) => {
  console.log('🧪 TEST ENDPOINT HIT:', req.body);
  const twiml = new MessagingResponse();
  twiml.message('TEST MESSAGE - If you see this, delivery works!');
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// Test validation endpoint - to verify validation is working
app.post('/test-validation', (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.json({ error: 'Please provide a message in the request body' });
  }
  
  const validation = validateRequestText(message, 0, req.body.client || 'amazon');
  
  res.json({
    message: message,
    validation: validation,
    timestamp: new Date().toISOString(),
    version: '2.0.0-validation-fix'
  });
});

// Clear flows endpoint (for debugging)
app.post('/clear-flows', requireAdmin, (req, res) => {
  conversationFlow.clearAllFlows();
  res.json({ success: true, message: 'All conversation flows cleared' });
});

// Normalize statuses endpoint (fixes filtering issues)
app.post('/normalize-statuses', requireAdmin, async (req, res) => {
  try {
    const result = await googleSheets.normalizeAllStatuses();
    res.json({ 
      success: true, 
      message: `Normalized ${result.processedCount} status values (${result.normalizedCount} changed)`,
      ...result
    });
  } catch (error) {
    console.error('Error normalizing statuses:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Force fix all "Completed" statuses
app.post('/fix-completed-statuses', requireAdmin, async (req, res) => {
  try {
    const result = await googleSheets.fixCompletedStatuses();
    res.json({ 
      success: true, 
      message: `Fixed ${result.fixedCount} "Completed" statuses`,
      ...result
    });
  } catch (error) {
    console.error('Error fixing completed statuses:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Force fix ALL statuses to exact matches
app.post('/force-fix-all-statuses', requireAdmin, async (req, res) => {
  try {
    const result = await googleSheets.forceFixAllStatuses();
    res.json({ 
      success: true, 
      message: `Force fixed ${result.fixedCount} status values`,
      ...result
    });
  } catch (error) {
    console.error('Error force fixing statuses:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Diagnostic endpoint to check status values
app.get('/status-diagnostics', async (req, res) => {
  try {
    const result = await googleSheets.getStatusDiagnostics();
    res.json(result);
  } catch (error) {
    console.error('Error getting status diagnostics:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Broadcast message endpoint - send message to all users who submitted requests
app.post('/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    // Check if messaging service is configured
    if (!messaging.isConfigured()) {
      return res.status(500).json({
        success: false,
        error: 'Twilio messaging service is not configured. Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER environment variables.'
      });
    }

    console.log('📢 Starting broadcast message...');
    
    // Get all unique phone numbers from Google Sheets
    const phoneNumbers = await googleSheets.getUniquePhoneNumbers();

    if (phoneNumbers.length === 0) {
      return res.json({
        success: true,
        message: 'No phone numbers found in the system',
        total: 0,
        successful: 0,
        failed: 0
      });
    }

    console.log(`📱 Sending message to ${phoneNumbers.length} recipients...`);

    // Send messages with 1 second delay between each to avoid rate limits
    const results = await messaging.sendBulkMessages(
      phoneNumbers,
      message.trim(),
      {
        delayBetweenMessages: 1000, // 1 second between messages
        continueOnError: true // Continue even if some fail
      }
    );

    res.json({
      success: true,
      message: `Broadcast completed: ${results.successful} successful, ${results.failed} failed`,
      total: results.total,
      successful: results.successful,
      failed: results.failed,
      errors: results.errors.length > 0 ? results.errors.slice(0, 10) : [] // Show first 10 errors
    });

  } catch (error) {
    console.error('❌ Error sending broadcast:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get list of all unique phone numbers (for preview before broadcast)
app.get('/broadcast/recipients', requireAdmin, async (req, res) => {
  try {
    const phoneNumbers = await googleSheets.getUniquePhoneNumbers();
    
    res.json({
      success: true,
      count: phoneNumbers.length,
      phoneNumbers: phoneNumbers
    });
  } catch (error) {
    console.error('Error getting recipients:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Format sheet endpoint - apply professional styling
app.post('/format-sheet', requireAdmin, async (req, res) => {
  try {
    const result = await googleSheets.formatSheet();
    res.json(result);
  } catch (error) {
    console.error('Error formatting sheet:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Tree Logistics WhatsApp Bot running on port ${PORT}`);
  console.log(`📦 Version: ${VERSION}`);
  console.log(`🕐 Started: ${new Date().toISOString()}`);
  console.log('='.repeat(50));
  console.log(`📱 Webhook: POST http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🏥 Health: GET http://localhost:${PORT}/health`);
  console.log(`🧪 Test: POST http://localhost:${PORT}/test`);
  console.log(`✅ Validation Test: POST http://localhost:${PORT}/test-validation`);
  console.log(`📋 Root: GET http://localhost:${PORT}/`);
  console.log('='.repeat(50));
  console.log('🔍 Validation Features:');
  console.log('  ✅ Vacation requests require dates');
  console.log('  ✅ Scanner requests require status (working/broken)');
  console.log('  ✅ IBAN changes require new IBAN number');
  console.log('='.repeat(50));
  console.log(`  - Twilio signature enforcement: ${ENFORCE_SIGNATURE ? '✅ ON' : '⚠️  log-only (set TWILIO_VALIDATE_SIGNATURE=true to enforce)'}`);
  console.log(`  - Admin endpoint secret: ${ADMIN_SECRET ? '✅ required' : '⚠️  NOT SET — /broadcast and status-rewrite endpoints are public'}`);
  console.log('='.repeat(50));
  console.log('Environment check:');
  console.log(`  - PORT: ${PORT}`);
  console.log(`  - GOOGLE_SHEET_ID: ${process.env.GOOGLE_SHEET_ID ? '✅ Set' : '❌ Missing'}`);
  console.log(`  - GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? '✅ Set' : '❌ Missing'}`);
  console.log('='.repeat(50));
});