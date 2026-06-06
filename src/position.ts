export interface Position {
  side: "LONG";
  entryPrice: number;
  quantity: number;
  highestSinceEntry: number;
  openedAt: string;
}

let position: Position | null = null;

export function initPositionFromStore(initial: Position | null): void {
  if (initial) position = initial;
}

export function getPosition(): Position | null {
  return position;
}

export function openLong(entryPrice: number, quantity: number): void {
  position = {
    side: "LONG",
    entryPrice,
    quantity,
    highestSinceEntry: entryPrice,
    openedAt: new Date().toISOString(),
  };
  persistHook(position);
}

export function addToLong(price: number, quantity: number): void {
  if (!position) {
    openLong(price, quantity);
    return;
  }
  const totalQty = position.quantity + quantity;
  position.entryPrice =
    (position.entryPrice * position.quantity + price * quantity) / totalQty;
  position.quantity = totalQty;
  if (price > position.highestSinceEntry) {
    position.highestSinceEntry = price;
  }
  persistHook(position);
}

export function updateHighest(price: number): void {
  if (!position) return;
  if (price > position.highestSinceEntry) {
    position.highestSinceEntry = price;
  }
}

export function closePosition(): void {
  position = null;
  persistHook(null);
}

export function hasOpenPosition(): boolean {
  return position !== null;
}

let persistHook: (p: Position | null) => void = () => {};

export function setPositionPersistHook(fn: (p: Position | null) => void): void {
  persistHook = fn;
}
