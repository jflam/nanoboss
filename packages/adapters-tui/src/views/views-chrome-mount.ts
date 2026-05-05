import type { Component } from "../shared/pi-tui.ts";
import type { UiState } from "../state/state.ts";
import type {
  ChromeContribution,
  ChromeRenderContext,
} from "../core/chrome.ts";

export interface StatefulChromeChild {
  setState(state: UiState): void;
}

interface ChromeMountContainer {
  addChild(child: Component): void;
}

class GatedComponent implements Component {
  constructor(
    private readonly inner: Component,
    private readonly gate: () => boolean,
  ) {}

  render(width: number): string[] {
    if (!this.gate()) {
      return [];
    }
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

export function mountChromeContribution(params: {
  container: ChromeMountContainer;
  contribution: ChromeContribution;
  ctx: ChromeRenderContext;
  getState: () => UiState;
  statefulChildren: StatefulChromeChild[];
}): void {
  const component = params.contribution.render(params.ctx);
  const gated = params.contribution.shouldRender
    ? new GatedComponent(component, () => params.contribution.shouldRender!(params.getState()))
    : component;
  params.container.addChild(gated);
  const candidate = component as unknown as { setState?: (state: UiState) => void };
  if (typeof candidate.setState === "function") {
    const setState = candidate.setState.bind(component);
    params.statefulChildren.push({ setState: (state) => setState(state) });
  }
}
