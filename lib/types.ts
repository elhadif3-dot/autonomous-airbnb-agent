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
};

export type SupervisorDecision = "Approve" | "Revise" | "Block";
