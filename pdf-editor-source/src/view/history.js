// Back/forward navigation history for one viewer (Alt+← / Alt+→).
const LIMIT = 100;

export class NavHistory {
  constructor() {
    this.backStack = [];
    this.forwardStack = [];
  }

  /** Remember where we are before jumping somewhere else. */
  push(position) {
    const top = this.backStack.at(-1);
    if (top && top.page === position.page && Math.abs((top.anchor?.fy ?? 0) - (position.anchor?.fy ?? 0)) < 0.01) return;
    this.backStack.push(position);
    if (this.backStack.length > LIMIT) this.backStack.shift();
    this.forwardStack = [];
  }

  back(current) {
    const target = this.backStack.pop();
    if (target) this.forwardStack.push(current);
    return target ?? null;
  }

  forward(current) {
    const target = this.forwardStack.pop();
    if (target) this.backStack.push(current);
    return target ?? null;
  }

  get canBack() {
    return this.backStack.length > 0;
  }

  get canForward() {
    return this.forwardStack.length > 0;
  }
}
