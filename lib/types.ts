export type Listing = {
  id: string;
  name: string;
  description: string;
  neighbourhood: string;
  latitude: number;
  longitude: number;
  propertyType: string;
  roomType: string;
  accommodates: number;
  bathroomsText: string;
  bedrooms: number | null;
  beds: number | null;
  amenities: string[];
  price: string;
  reviewScore: number | null;
  locationScore: number | null;
  valueScore: number | null;
  numberOfReviews: number;
  nearbyPlacesCount: number;
};

export type Review = {
  listingId: string;
  id: string;
  date: string;
  comments: string;
};

export type Place = {
  placeName: string;
  category: string;
  rating: number | null;
  numberOfReviews: number;
  reviewsContent: string;
  latitude: number;
  longitude: number;
  distanceKm?: number;
};

export type AgentStep = {
  module: string;
  prompt: {
    system_prompt: string;
    user_prompt: string;
  };
  response: unknown;
};

export type ExecuteResponse = {
  status: "ok" | "error";
  error: string | null;
  response: string | null;
  steps: AgentStep[];
  page_update?: SimulatedPageUpdate | null;
  portfolio_update?: PortfolioUpdate | null;
  manager_recommendations?: ManagerRecommendation[] | null;
  audit_log?: AuditLogEntry | null;
};

export type PortfolioListingResult = {
  listingId: string;
  listingName: string;
  status: "executed" | "not_executed" | "error";
  decision: SupervisorDecision | null;
  response: string | null;
  updatedField: "description" | null;
  addedText: string | null;
  before: string | null;
  after: string | null;
  selectedActions: string[];
};

export type PortfolioUpdate = {
  requestedListings: number;
  executed: number;
  skipped: number;
  results: PortfolioListingResult[];
};

export type SupervisorDecision = "Approve" | "Revise" | "Block";

export type ManagerRecommendation = {
  topic: string;
  priority: "high" | "medium" | "low";
  guestSignal: string;
  suggestedAction: string;
  businessValue: string;
  evidenceCount: number;
  evidence: string[];
};

export type SimulatedListingPage = {
  listingId: string;
  currentDescription: string;
  updatedAt: string;
};

export type SimulatedPageUpdate = {
  listingId: string;
  status: "executed" | "not_executed";
  field: "description" | null;
  before: string | null;
  after: string | null;
  addedText: string | null;
};

export type AuditLogEntry = {
  id: string;
  listingId: string;
  listingName: string;
  managerPrompt: string;
  decision: SupervisorDecision;
  selectedActions: string[];
  evidenceSummary: unknown;
  proposal: unknown;
  supervisorRationale: string;
  executedInDemoEnvironment: boolean;
  liveAirbnbUpdated: false;
  createdAt: string;
};
