# Design Document: Progressive Greeting Demo

Date: 2026-07-25  
Card/Issue Ref: `progressive-greeting` (Pipeline Smoke Test)  
Slug: `progressive-greeting`

---

## Problem statement

### Needed Behavior
For the new `card-types` feature pipeline validation, we require a tiny, self-contained, and highly deterministic code utility—the **progressive greeting helper**—to serve as an end-to-end smoke test target. This utility must print a localized greeting that adapts progressively to the fidelity of the provided execution context, fallback gracefully at each level, and have zero external dependencies.

### Observed Symptom / Current Gap
There is currently no simple, zero-dependency utility in the codebase designed specifically to serve as an active code target for validating new build, plan, and test pipeline phases. Without such a target, testing the pipeline end-to-end requires running against real production CLI code, increasing risk and complicating the validation process.

### Root Cause
We lack a dedicated, isolated domain module that can be introduced, tested, and modified to prove that the planning, building, and review phases of custom card-types are executing, compiling, and testing correctly.

---

## What exists in the codebase

The project uses a standard TypeScript architecture where core domain behaviors are located in `src/core/` and unit/integration tests are kept under `test/runtime/`.

### Canonical Locations and Core References
- **Domain Modules:** Existing simple core domain utilities, like `src/core/task-id.ts` and `src/core/task-title.ts`, define narrow, typed functions for manipulation and mapping.
- **Unit Testing Suite:** Unit tests under `test/runtime/core/` (e.g., `test/runtime/core/task-id.test.ts`) leverage `vitest` for fast, lightweight assertion execution with minimal mocking (adhering to Article 4 of the Constitution).
- **Prior Art SHAs Read:** None. This is an entirely isolated, purely additive smoke test with no historical or legacy context.

---

## Proposed solution

We propose implementing a new utility module at `src/core/progressive-greeting.ts` along with a corresponding test suite at `test/runtime/core/progressive-greeting.test.ts`.

### Step 1: Core Module (`src/core/progressive-greeting.ts`)
The utility will export a clean, type-safe API with progressive fallback logic. It will accept an optional `GreetingContext` object containing a name, an explicit time-of-day period, or a `Date` timestamp.

#### Code Specification:
```typescript
export interface GreetingContext {
  /** The name of the user to greet (e.g., "Alice") */
  name?: string | null;
  /** Explicit override for the time of day period */
  timeOfDay?: "morning" | "afternoon" | "evening" | null;
  /** A Date object used to dynamically compute the time of day if no override is provided */
  timestamp?: Date | null;
}

/**
 * Maps a hour of the day to a specific day period.
 * Morning: 5:00 AM - 11:59 AM
 * Afternoon: 12:00 PM - 4:59 PM
 * Evening: 5:00 PM - 4:59 AM
 */
export function resolveTimeOfDay(date: Date): "morning" | "afternoon" | "evening" {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) {
    return "morning";
  }
  if (hour >= 12 && hour < 17) {
    return "afternoon";
  }
  return "evening";
}

/**
 * Generates a localized greeting that adapts progressively to the available context.
 * 
 * Progressions:
 * 1. Plain (Minimum Fallback): "Hello!"
 * 2. Named Only: "Hello, Alice!"
 * 3. Time of Day Only: "Good morning!"
 * 4. Named + Time of Day (Full Context): "Good morning, Alice!"
 */
export function generateProgressiveGreeting(context?: GreetingContext | null): string {
  if (!context) {
    return "Hello!";
  }

  const { name, timeOfDay, timestamp } = context;

  // Resolve the time period, favoring explicit overrides over dynamic timestamps
  let resolvedPeriod: "morning" | "afternoon" | "evening" | null = timeOfDay || null;
  if (!resolvedPeriod && timestamp) {
    resolvedPeriod = resolveTimeOfDay(timestamp);
  }

  if (name && resolvedPeriod) {
    return `Good ${resolvedPeriod}, ${name}!`;
  }

  if (resolvedPeriod) {
    return `Good ${resolvedPeriod}!`;
  }

  if (name) {
    return `Hello, ${name}!`;
  }

  return "Hello!";
}
```

### Step 2: Unit Testing (`test/runtime/core/progressive-greeting.test.ts`)
We will write a comprehensive, dependency-free suite of tests in Vitest that exercises the external API of our progressive greeting module across all fallbacks and scenarios.

#### Test Specification:
```typescript
import { describe, expect, it } from "vitest";
import { generateProgressiveGreeting, resolveTimeOfDay } from "../../../src/core/progressive-greeting";

describe("Progressive Greeting Helper", () => {
  describe("resolveTimeOfDay", () => {
    it("should resolve morning hours (5 AM - 11 AM)", () => {
      const morningDate = new Date();
      morningDate.setHours(8);
      expect(resolveTimeOfDay(morningDate)).toBe("morning");
    });

    it("should resolve afternoon hours (12 PM - 4 PM)", () => {
      const afternoonDate = new Date();
      afternoonDate.setHours(14);
      expect(resolveTimeOfDay(afternoonDate)).toBe("afternoon");
    });

    it("should resolve evening hours (5 PM - 4 AM)", () => {
      const eveningDate = new Date();
      eveningDate.setHours(21);
      expect(resolveTimeOfDay(eveningDate)).toBe("evening");
    });
  });

  describe("generateProgressiveGreeting", () => {
    it("should fall back to plain greeting when context is empty/null/undefined", () => {
      expect(generateProgressiveGreeting()).toBe("Hello!");
      expect(generateProgressiveGreeting(null)).toBe("Hello!");
      expect(generateProgressiveGreeting({})).toBe("Hello!");
    });

    it("should return named greeting if only name is provided", () => {
      expect(generateProgressiveGreeting({ name: "Alice" })).toBe("Hello, Alice!");
    });

    it("should return time-of-day greeting if only period is provided", () => {
      expect(generateProgressiveGreeting({ timeOfDay: "morning" })).toBe("Good morning!");
    });

    it("should return dynamic time-of-day greeting if only timestamp is provided", () => {
      const afternoonDate = new Date();
      afternoonDate.setHours(13);
      expect(generateProgressiveGreeting({ timestamp: afternoonDate })).toBe("Good afternoon!");
    });

    it("should return personalized time-of-day greeting if both name and period are provided", () => {
      expect(
        generateProgressiveGreeting({ name: "Alice", timeOfDay: "evening" })
      ).toBe("Good evening, Alice!");
    });

    it("should return personalized time-of-day greeting if both name and timestamp are provided", () => {
      const morningDate = new Date();
      morningDate.setHours(9);
      expect(
        generateProgressiveGreeting({ name: "Alice", timestamp: morningDate })
      ).toBe("Good morning, Alice!");
    });

    it("should prioritize explicit timeOfDay override over timestamp", () => {
      const morningDate = new Date();
      morningDate.setHours(9); // Morning
      expect(
        generateProgressiveGreeting({ name: "Alice", timeOfDay: "evening", timestamp: morningDate })
      ).toBe("Good evening, Alice!");
    });
  });
});
```

---

## Technical rationale

### Structural & Idiomatic Alignment
- **Type Safety:** The solution leverages strict, explicit interfaces matching the requirements of **Article 8** of the Constitution (No `any`, typed parameters).
- **Module Design:** By exposing pure functions that do not keep static state, we eliminate side-effects and simplify parallel execution.
- **Minimal Mocking:** Per **Article 4** of the Constitution, testing is driven through the public API of the module. Since we can pass explicit timestamps or mock dates using standard JavaScript `Date` constructors, there is absolutely zero need to mock timezone libraries or the system clock. This prevents the tests from becoming fragile.

### Alternatives Considered and Rejected
1. **Adding Greeting Helpers directly into CLI output routines (`src/cli.ts`):**  
   *Reason for rejection:* Violates separation of concerns. Presentational CLI structures shouldn't carry core functional logic or calendar/time rules.
2. **Introducing an External Time/Date Formatting Dependency:**  
   *Reason for rejection:* Violates the mandate for zero-dependency lightweight code. Native JS `getHours()` provides everything required for simple hourly periodization with absolute reliability.

### Risks and Mitigations
- **Timezone shifts on CI runners:** The test suite resolves periods relative to the system date constructed via `new Date()`. Because we set local hours explicitly on test instances (`date.setHours(...)`), the dynamic resolution will be relative to the runner's timezone, ensuring consistent green runs regardless of the runner's location.

---

## Open questions

1. **How should we handle capitalization?**  
   *Answer:* The output string uses standard sentence-case typography ("Good morning, Alice!"). This provides the cleanest visual representation.
2. **Are other periodizations (such as "night" or "dawn") required?**  
   *Answer:* No. To keep this smoke test minimal, standard `morning`, `afternoon`, and `evening` provide sufficient coverage of the conditional execution paths.

---

## Disposition

**Recommend:** `implement-here`.  
The design is extremely well-scoped and ready for immediate implementation in a subsequent build phase, as it is isolated, safe, and fully specified.
