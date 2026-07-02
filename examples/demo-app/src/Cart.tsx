/**
 * Cart — state-override verification target for Easel #17 "Live State Puppeteer".
 *
 * The `items` array lives directly in this component's React state so Easel's
 * fiber tap can locate and replace it.
 *
 * State shape:
 *   Component display name : "Cart"
 *   useState hook index    : 0  (the first and only useState call)
 *   Value type             : CartItem[]
 *
 * Fiber selector path (for the orchestrator):
 *   selector  → "[data-easel-component='Cart']"
 *   hook path → stateNode.memoizedState.queue  (hook index 0)
 *
 * Try it:
 *   Enable State Puppeteer in Easel → ask "show the empty cart state"
 *   Easel will write [] into the items hook, collapsing the cart to the empty view.
 */

import React, { useState } from 'react';

export interface CartItem {
  id: number;
  name: string;
  unitPrice: number;
  qty: number;
}

/** Default seed — non-empty so the "before" state is interesting. */
const SEED_ITEMS: CartItem[] = [
  { id: 1, name: 'Nimbus Pro Plan (annual)', unitPrice: 99, qty: 1 },
  { id: 2, name: 'Extra team seat', unitPrice: 15, qty: 3 },
];

export default function Cart(): React.ReactElement {
  // Hook index 0 — this is the state-override target.
  const [items, setItems] = useState<CartItem[]>(SEED_ITEMS);

  const total = items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);

  function addSampleItem() {
    setItems((prev) => [
      ...prev,
      {
        id: Date.now(),
        name: 'Add-on module',
        unitPrice: 9,
        qty: 1,
      },
    ]);
  }

  return (
    <div className="puppeteer-panel" data-easel-component="Cart">
      <div className="puppeteer-panel-header">
        <span className="puppeteer-label">
          Cart ({items.length} {items.length === 1 ? 'item' : 'items'})
        </span>
        <span className="puppeteer-badge">state-override target</span>
      </div>

      {items.length === 0 ? (
        <div className="puppeteer-empty-state">
          <p className="puppeteer-empty-heading">Your cart is empty</p>
          <p className="puppeteer-empty-body">
            State Puppeteer wrote <code>[]</code> into the items hook — this is
            the empty-cart state.
          </p>
        </div>
      ) : (
        <>
          <ul className="cart-list">
            {items.map((item) => (
              <li key={item.id} className="cart-row">
                <span className="cart-item-name">{item.name}</span>
                <span className="cart-item-meta">
                  {item.qty} × ${item.unitPrice.toFixed(2)}
                </span>
                <span className="cart-item-subtotal">
                  ${(item.unitPrice * item.qty).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          <div className="cart-footer">
            <span className="cart-total-label">Total</span>
            <span className="cart-total-value">${total.toFixed(2)}</span>
          </div>
        </>
      )}

      <div className="cart-actions">
        <button className="btn btn-secondary" onClick={addSampleItem}>
          Add sample item
        </button>
      </div>
    </div>
  );
}
