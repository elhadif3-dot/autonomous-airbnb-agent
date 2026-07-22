import type {
  AuditLogEntry,
  Listing,
  SimulatedListingPage,
  SimulatedPageUpdate,
  SupervisorDecision
} from "@/lib/types";
import type { EditProposal } from "@/lib/schemas";

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

export function getSimulatedListingPage(listing: Listing): SimulatedListingPage {
  const existing = store().pages.get(listing.id);
  if (existing) {
    return existing;
  }

  const page = {
    listingId: listing.id,
    currentDescription: listing.description,
    updatedAt: new Date().toISOString()
  };
  store().pages.set(listing.id, page);
  return page;
}

export function applySimulatedPageUpdate(
  listing: Listing,
  proposal: EditProposal,
  decision: SupervisorDecision
): SimulatedPageUpdate {
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
      addedText: null
    };
  }

  const page = getSimulatedListingPage(listing);
  const before = page.currentDescription;
  const after = appendIfMissing(before, proposal.proposed_description_addition);
  const updated = {
    ...page,
    currentDescription: after,
    updatedAt: new Date().toISOString()
  };

  store().pages.set(listing.id, updated);

  return {
    listingId: listing.id,
    status: "executed",
    field: "description",
    before,
    after,
    addedText: proposal.proposed_description_addition
  };
}

export function createAuditLog(input: {
  listing: Listing;
  managerPrompt: string;
  decision: SupervisorDecision;
  selectedActions: string[];
  evidenceSummary: unknown;
  proposal: unknown;
  supervisorRationale: string;
  executedInDemoEnvironment: boolean;
}): AuditLogEntry {
  const audit: AuditLogEntry = {
    id: crypto.randomUUID(),
    listingId: input.listing.id,
    listingName: input.listing.name,
    managerPrompt: input.managerPrompt,
    decision: input.decision,
    selectedActions: input.selectedActions,
    evidenceSummary: input.evidenceSummary,
    proposal: input.proposal,
    supervisorRationale: input.supervisorRationale,
    executedInDemoEnvironment: input.executedInDemoEnvironment,
    liveAirbnbUpdated: false,
    createdAt: new Date().toISOString()
  };

  store().audits.unshift(audit);
  return audit;
}

export function getAuditLogs(listingId?: string): AuditLogEntry[] {
  return store().audits.filter((audit) => !listingId || audit.listingId === listingId);
}

export function resetSimulatedListingPage(listing: Listing): SimulatedListingPage {
  const page = {
    listingId: listing.id,
    currentDescription: listing.description,
    updatedAt: new Date().toISOString()
  };
  store().pages.set(listing.id, page);
  return page;
}

function appendIfMissing(description: string, addition: string): string {
  if (description.includes(addition)) {
    return description;
  }

  return `${description}\n\n${addition}`;
}
