import type { Review } from "@/lib/types";

type CoverageState = {
  cursor: number;
  coveredIds: Set<string>;
  completed: boolean;
  updatedAt: string;
};

type Store = {
  scopes: Map<string, CoverageState>;
};

type ReviewCoverageInput = {
  sessionId: string;
  listingId: string;
  scopeKey: string;
  reviews: Review[];
  windowSize: number;
};

export type ReviewCoverageResult = {
  scopeKey: string;
  reviews: Review[];
  totalReviewsInScope: number;
  previouslyCoveredCount: number;
  newlyCoveredCount: number;
  coveredAfterCount: number;
  cursorStart: number;
  cursorEnd: number;
  completed: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __airbnbReviewCoverageStore?: Store;
};

function store(): Store {
  if (!globalStore.__airbnbReviewCoverageStore) {
    globalStore.__airbnbReviewCoverageStore = {
      scopes: new Map()
    };
  }

  return globalStore.__airbnbReviewCoverageStore;
}

export function selectNextReviewCoverageWindow(input: ReviewCoverageInput): ReviewCoverageResult {
  const reviews = uniqueReviews(input.reviews);
  const key = coverageKey(input.sessionId, input.listingId, input.scopeKey);
  const current = store().scopes.get(key) ?? {
    cursor: 0,
    coveredIds: new Set<string>(),
    completed: false,
    updatedAt: new Date().toISOString()
  };

  const totalReviewsInScope = reviews.length;
  const previouslyCoveredCount = Math.min(current.coveredIds.size, totalReviewsInScope);
  const windowSize = Math.max(1, Math.min(input.windowSize, totalReviewsInScope || input.windowSize));

  if (totalReviewsInScope === 0) {
    const empty = {
      ...current,
      cursor: 0,
      completed: true,
      updatedAt: new Date().toISOString()
    };
    store().scopes.set(key, empty);
    return {
      scopeKey: input.scopeKey,
      reviews: [],
      totalReviewsInScope: 0,
      previouslyCoveredCount: 0,
      newlyCoveredCount: 0,
      coveredAfterCount: 0,
      cursorStart: 0,
      cursorEnd: 0,
      completed: true
    };
  }

  const start = current.completed ? 0 : current.cursor % totalReviewsInScope;
  const selected: Review[] = [];
  const selectedIds = new Set<string>();
  let cursor = start;
  let visited = 0;

  while (selected.length < windowSize && visited < totalReviewsInScope) {
    const review = reviews[cursor];
    const id = reviewKey(review);
    if (!current.coveredIds.has(id) && !selectedIds.has(id)) {
      selected.push(review);
      selectedIds.add(id);
    }
    cursor = (cursor + 1) % totalReviewsInScope;
    visited += 1;
  }

  for (const id of selectedIds) {
    current.coveredIds.add(id);
  }

  current.cursor = cursor;
  current.completed = current.coveredIds.size >= totalReviewsInScope;
  current.updatedAt = new Date().toISOString();
  store().scopes.set(key, current);

  return {
    scopeKey: input.scopeKey,
    reviews: selected,
    totalReviewsInScope,
    previouslyCoveredCount,
    newlyCoveredCount: selected.length,
    coveredAfterCount: Math.min(current.coveredIds.size, totalReviewsInScope),
    cursorStart: start,
    cursorEnd: cursor,
    completed: current.completed
  };
}

export function resetReviewCoverageForListing(sessionId: string, listingId: string): void {
  const prefix = `${safeKey(sessionId)}:${listingId}:`;
  for (const key of store().scopes.keys()) {
    if (key.startsWith(prefix)) {
      store().scopes.delete(key);
    }
  }
}

function uniqueReviews(reviews: Review[]): Review[] {
  const seen = new Set<string>();
  const unique: Review[] = [];
  for (const review of reviews) {
    const key = reviewKey(review);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(review);
    }
  }
  return unique;
}

function reviewKey(review: Review): string {
  return review.id || `${review.listingId}:${review.date}:${review.comments.slice(0, 80)}`;
}

function coverageKey(sessionId: string, listingId: string, scopeKey: string): string {
  return `${safeKey(sessionId)}:${listingId}:${safeKey(scopeKey)}`;
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 180);
}
