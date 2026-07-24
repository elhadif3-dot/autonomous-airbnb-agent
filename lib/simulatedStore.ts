import type {
  AuditLogEntry,
  Listing,
  SimulatedListingPage,
  SimulatedPageUpdate,
  SupervisorDecision
} from "@/lib/types";
import type { EditProposal } from "@/lib/schemas";
import {
  fetchSupabaseAuditLogs,
  getSupabaseSimulatedPage,
  insertSupabaseAuditLog,
  isSupabaseConfigured,
  upsertSupabaseSimulatedPage
} from "@/lib/supabaseRuntime";

type Store = {
  pages: Map<string, SimulatedListingPage>;
  audits: AuditLogEntry[];
};

const globalStore = globalThis as typeof globalThis & {
  __airbnbAgentStore?: Store;
};

function store(): Store {
  if (!globalStore.__airbnbAgentStore) {
    globalStore.__airbnbAgentStore = {
      pages: new Map<string, SimulatedListingPage>(),
      audits: []
    };
  }

  return globalStore.__airbnbAgentStore;
}

export async function getSimulatedListingPage(listing: Listing, currentDescriptionOverride?: string): Promise<SimulatedListingPage> {
  if (isSupabaseConfigured() && typeof currentDescriptionOverride !== "string") {
    const page = await getSupabaseSimulatedPage(listing);
    if (page) {
      return page;
    }
  }

  if (typeof currentDescriptionOverride === "string") {
    const page = {
      listingId: listing.id,
      currentDescription: currentDescriptionOverride,
      previousDescription: null,
      updatedAt: new Date().toISOString()
    };
    store().pages.set(listing.id, page);
    return page;
  }

  const existing = store().pages.get(listing.id);
  if (existing) {
    return existing;
  }

  const page = {
    listingId: listing.id,
    currentDescription: listing.description,
    previousDescription: null,
    updatedAt: new Date().toISOString()
  };
  store().pages.set(listing.id, page);
  return page;
}

export async function applySimulatedPageUpdate(
  listing: Listing,
  proposal: EditProposal,
  decision: SupervisorDecision,
  previousDescription?: string
): Promise<SimulatedPageUpdate> {
  if (decision === "Approve" && proposal.action === "restore_previous_page") {
    const page = await getSimulatedListingPage(listing);
    const before = page.currentDescription;
    const restoreTarget = previousDescription ?? page.previousDescription ?? undefined;

    if (!restoreTarget || normalizedText(restoreTarget) === normalizedText(before)) {
      return {
        listingId: listing.id,
        status: "not_executed",
        field: "description",
        before,
        after: before,
        addedText: null,
        reason: "No previous simulated page version was available to restore."
      };
    }

    const updated = {
      ...page,
      currentDescription: restoreTarget,
      previousDescription: before,
      updatedAt: new Date().toISOString()
    };

    await savePage(updated);

    return {
      listingId: listing.id,
      status: "executed",
      field: "description",
      before,
      after: restoreTarget,
      addedText: "Restored the simulated listing description to the previous version text."
    };
  }

  if (decision === "Approve" && proposal.action === "restore_original_page") {
    const page = await getSimulatedListingPage(listing);
    const before = page.currentDescription;

    if (normalizedText(before) === normalizedText(listing.description)) {
      return {
        listingId: listing.id,
        status: "not_executed",
        field: "description",
        before,
        after: before,
        addedText: null,
        reason: "The simulated page was already at the original dataset description."
      };
    }

    const updated = {
      ...page,
      currentDescription: listing.description,
      previousDescription: before,
      updatedAt: new Date().toISOString()
    };

    await savePage(updated);

    return {
      listingId: listing.id,
      status: "executed",
      field: "description",
      before,
      after: listing.description,
      addedText: "Restored the simulated listing description to the original dataset text."
    };
  }

  if (
    decision === "Approve" &&
    proposal.action === "replace_description" &&
    proposal.proposed_description_replacement &&
    proposal.target_fields.includes("description")
  ) {
    const page = await getSimulatedListingPage(listing);
    const before = page.currentDescription;
    const after = proposal.proposed_description_replacement.trim();

    if (normalizedText(after) === normalizedText(before)) {
      return {
        listingId: listing.id,
        status: "not_executed",
        field: "description",
        before,
        after: before,
        addedText: null,
        reason: "The rewritten description did not create an effective page change."
      };
    }

    const updated = {
      ...page,
      currentDescription: after,
      previousDescription: before,
      updatedAt: new Date().toISOString()
    };

    await savePage(updated);

    return {
      listingId: listing.id,
      status: "executed",
      field: "description",
      before,
      after,
      addedText: after
    };
  }

  if (
    decision !== "Approve" ||
    proposal.action !== "prepare_edit_proposal" ||
    !proposal.proposed_description_addition ||
    !proposal.target_fields.includes("description")
  ) {
    return {
      listingId: listing.id,
      status: "not_executed",
      field: null,
      before: null,
      after: null,
      addedText: null,
      reason: proposal.reason ?? "The proposal was not approved for execution."
    };
  }

  const page = await getSimulatedListingPage(listing);
  const before = page.currentDescription;
  const after = appendIfMissing(before, proposal.proposed_description_addition);

  if (normalizedText(after) === normalizedText(before)) {
    return {
      listingId: listing.id,
      status: "not_executed",
      field: "description",
      before,
      after,
      addedText: null,
      reason: "The current simulated description already contains the proposed update, so no new page change was executed."
    };
  }

  const updated = {
    ...page,
    currentDescription: after,
    previousDescription: before,
    updatedAt: new Date().toISOString()
  };

  await savePage(updated);

  return {
    listingId: listing.id,
    status: "executed",
    field: "description",
    before,
    after,
    addedText: proposal.proposed_description_addition
  };
}

export async function createAuditLog(input: {
  listing: Listing;
  managerPrompt: string;
  decision: SupervisorDecision;
  selectedActions: string[];
  evidenceSummary: unknown;
  proposal: unknown;
  pageUpdate?: SimulatedPageUpdate | null;
  supervisorRationale: string;
  executedInDemoEnvironment: boolean;
}): Promise<AuditLogEntry> {
  const audit: AuditLogEntry = {
    id: crypto.randomUUID(),
    listingId: input.listing.id,
    listingName: input.listing.name,
    managerPrompt: input.managerPrompt,
    decision: input.decision,
    selectedActions: input.selectedActions,
    evidenceSummary: input.evidenceSummary,
    proposal: input.proposal,
    pageUpdate: input.pageUpdate ?? null,
    supervisorRationale: input.supervisorRationale,
    executedInDemoEnvironment: input.executedInDemoEnvironment,
    liveAirbnbUpdated: false,
    createdAt: new Date().toISOString()
  };

  store().audits.unshift(audit);
  return insertSupabaseAuditLog(audit);
}

export async function getAuditLogs(listingId?: string): Promise<AuditLogEntry[]> {
  const supabaseAudits = await fetchSupabaseAuditLogs(listingId);
  if (supabaseAudits) {
    return supabaseAudits;
  }

  return store().audits.filter((audit) => !listingId || audit.listingId === listingId);
}

export async function resetSimulatedListingPage(listing: Listing): Promise<SimulatedListingPage> {
  const page = {
    listingId: listing.id,
    currentDescription: listing.description,
    previousDescription: null,
    updatedAt: new Date().toISOString()
  };
  return savePage(page);
}

async function savePage(page: SimulatedListingPage): Promise<SimulatedListingPage> {
  store().pages.set(page.listingId, page);
  if (isSupabaseConfigured()) {
    return upsertSupabaseSimulatedPage(page);
  }

  return page;
}

function appendIfMissing(description: string, addition: string): string {
  if (normalizedText(description).includes(normalizedText(addition))) {
    return description;
  }

  const missingSentences = splitSentences(addition).filter(
    (sentence) => !textAlreadyContainsSentence(description, sentence)
  );

  if (missingSentences.length === 0) {
    return description;
  }

  return `${description.trim()}\n\n${missingSentences.join(" ")}`.trim();
}

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function textAlreadyContainsSentence(description: string, sentence: string): boolean {
  const normalizedSentence = normalizedText(sentence);
  if (!normalizedSentence) {
    return true;
  }

  const normalizedDescription = normalizedText(description);
  if (normalizedDescription.includes(normalizedSentence)) {
    return true;
  }

  return splitSentences(description).some((existing) => sentenceSimilarity(existing, sentence) >= 0.84);
}

function sentenceSimilarity(first: string, second: string): number {
  const firstTokens = contentTokens(first);
  const secondTokens = contentTokens(second);
  if (firstTokens.size === 0 || secondTokens.size === 0) {
    return 0;
  }

  const intersection = [...firstTokens].filter((token) => secondTokens.has(token)).length;
  return intersection / Math.max(firstTokens.size, secondTokens.size);
}

function contentTokens(value: string): Set<string> {
  const stopwords = new Set([
    "the",
    "and",
    "with",
    "that",
    "this",
    "from",
    "into",
    "only",
    "when",
    "guest",
    "guests",
    "review",
    "reviews",
    "listing",
    "stay"
  ]);

  return new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length > 2 && !stopwords.has(token))
  );
}
