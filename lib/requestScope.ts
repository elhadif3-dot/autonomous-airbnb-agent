export type ScopeDecision = {
  inScope: boolean;
  category: "listing_page_management" | "capability_question" | "out_of_scope";
  reason: string;
  safeResponse: string;
};

const metadataPatterns = [/selected listing id:\s*\d+/gi];

const allowedPatterns = [
  /\b(airbnb|listing|property|properties|rental|guest|review|description|amenit(?:y|ies)|nearby|place|places|lisbon|host|manager)\b/i,
  /\b(noise|quiet|wifi|wi-fi|internet|remote work|hill|steep|stairs|clean|comfort|location|attraction|restaurant|park|museum|viewpoint|issue|complaint|repair|maintenance)\b/i,
  /\b(improve|update|edit|restore|revert|undo|reset|audit|supervisor|gap|evidence|fix|recommendation|recommend|income|revenue|quality)\b/i,
  /נכס|נכסים|דירה|דירות|אירבינבי|אירבי|ביקור(?:ת|ות)|אורח(?:ים)?|תיאור|ערוך|תערוך|שחזר|תחזיר|בטל|מיקום|מסעדה|פארק|אטרקציה|ליסבון/
];

const strongDomainPatterns = [
  /\b(airbnb|listing|property|properties|rental|guest|review|description|amenit(?:y|ies)|host|manager)\b/i,
  /\b(improve|update|edit|restore|revert|undo|reset|audit|supervisor|gap|evidence)\b/i,
  /נכס|נכסים|דירה|דירות|אירבינבי|אירבי|ביקור(?:ת|ות)|אורח(?:ים)?|תיאור|ערוך|תערוך|שחזר|תחזיר|בטל|פער|ראיות/
];

const capabilityPatterns = [
  /\b(what can you do|help|capabilities|scope|tools)\b/i,
  /מה אתה|מה הסוכן|מה אפשר|יודע לעשות|יכול לעשות|יכולות|כלים|עזרה/
];

const forbiddenPatterns = [
  /\b(tire|tyre|tires|car|vehicle|mechanic|garage|flight|hotel booking|stock|crypto|loan|bank|recipe|homework|medical|lawyer)\b/i,
  /צמיג|צמיגים|רכב|מכונית|מוסך|טיסה|מניות|קריפטו|הלוואה|בנק|מתכון|רופא|עורך דין/
];

export function classifyPromptScope(prompt: string): ScopeDecision {
  const managerRequest = stripSystemMetadata(prompt).trim();

  if (managerRequest.length === 0) {
    return outOfScope("The request is empty after removing system metadata.");
  }

  if (capabilityPatterns.some((pattern) => pattern.test(managerRequest))) {
    return {
      inScope: true,
      category: "capability_question",
      reason: "The manager asked about the agent capability boundaries.",
      safeResponse:
        "I can help with the selected Lisbon Airbnb demo listing page: compare the page with guest reviews, use Google Places as supporting context, propose evidence-backed text edits, recommend property improvements from guest complaints, restore the simulated page to the original dataset text, and explain the audit trail. I cannot help with unrelated tasks, live Airbnb access, pricing, bookings, private messages, or editing guest reviews."
    };
  }

  const hasForbiddenTopic = forbiddenPatterns.some((pattern) => pattern.test(managerRequest));
  const hasAllowedTopic = allowedPatterns.some((pattern) => pattern.test(managerRequest));
  const hasStrongDomainTopic = strongDomainPatterns.some((pattern) => pattern.test(managerRequest));

  if (hasForbiddenTopic && !hasStrongDomainTopic) {
    return outOfScope("The request is unrelated to Lisbon Airbnb listing-page management.");
  }

  if (!hasAllowedTopic) {
    return outOfScope("The request does not match the agent's available tools or editable page scope.");
  }

  return {
    inScope: true,
    category: "listing_page_management",
    reason: "The request is related to the selected simulated Airbnb listing page.",
    safeResponse: ""
  };
}

function outOfScope(reason: string): ScopeDecision {
  return {
    inScope: false,
    category: "out_of_scope",
    reason,
    safeResponse:
      "I don't know how to complete that request with my allowed tools. I can only work on the selected Lisbon Airbnb demo listing page: evidence-backed description edits, guest-expectation notes, nearby highlights, review-based property improvement recommendations, restore-to-original, and audit logging. No LLM, RAG, Google Places, or page edit was used for this out-of-scope request."
  };
}

function stripSystemMetadata(prompt: string): string {
  return metadataPatterns.reduce((value, pattern) => value.replace(pattern, ""), prompt);
}
