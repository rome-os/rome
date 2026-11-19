// @rstest-environment jsdom
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { FEATURE_VISIBILITY } from "@rome/api-types/features";
import { AppFeatureRoute, FeatureGate, FeatureRoute } from "./feature-gate";
import { useBuiltinNav } from "@/shell/builtin-nav";
import type { GatedFeature } from "@rome/api-types/features";
import { hiddenFeatures, isShownInTest } from "@/test/features";

rs.mock("@/lib/features", () => ({
  isShown: (feature?: GatedFeature) => isShownInTest(feature),
}));

afterEach(() => {
  hiddenFeatures.clear();
  cleanup();
});

describe("this release", () => {
  it("hides People, Envoys and Inbox", () => {
    expect(FEATURE_VISIBILITY).toEqual({ people: false, envoys: false, inbox: false });
  });
});

describe("FeatureGate", () => {
  it("shows its children while the feature is shown", () => {
    render(
      <FeatureGate feature="people" fallback={<p>hidden</p>}>
        <p>people</p>
      </FeatureGate>,
    );
    expect(screen.getByText("people")).toBeTruthy();
  });

  it("shows the fallback while the feature is hidden", () => {
    hiddenFeatures.add("people");
    render(
      <FeatureGate feature="people" fallback={<p>hidden</p>}>
        <p>people</p>
      </FeatureGate>,
    );
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(screen.queryByText("people")).toBeNull();
  });
});

describe("FeatureRoute", () => {
  it("sends a hidden feature's address to the home page", () => {
    hiddenFeatures.add("envoys");
    render(
      <MemoryRouter initialEntries={["/envoys"]}>
        <Routes>
          <Route path="/" element={<p>home</p>} />
          <Route
            path="/envoys"
            element={
              <FeatureRoute feature="envoys">
                <p>envoys</p>
              </FeatureRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("home")).toBeTruthy();
  });
});

describe("AppFeatureRoute", () => {
  function openAppDetails(appId: string) {
    render(
      <MemoryRouter initialEntries={[`/app-details/${appId}`]}>
        <Routes>
          <Route path="/" element={<p>home</p>} />
          <Route
            path="/app-details/:appId"
            element={
              <AppFeatureRoute>
                <p>details</p>
              </AppFeatureRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("sends the details address of a hidden feature's app to the home page", () => {
    hiddenFeatures.add("inbox");
    openAppDetails("inbox");
    expect(screen.getByText("home")).toBeTruthy();
  });

  it("opens the details of an app that is no feature, or whose feature is shown", () => {
    hiddenFeatures.add("people");
    openAppDetails("inbox");
    expect(screen.getByText("details")).toBeTruthy();
    cleanup();
    hiddenFeatures.add("inbox");
    openAppDetails("notes");
    expect(screen.getByText("details")).toBeTruthy();
  });
});

describe("useBuiltinNav", () => {
  it("leaves out the pages of hidden features", () => {
    hiddenFeatures.add("people");
    const { result } = renderHook(() => useBuiltinNav());
    const ids = result.current.map((entry) => entry.id);
    expect(ids).not.toContain("people");
    expect(ids).toContain("envoys");
    expect(ids).toContain("memory");
  });
});
