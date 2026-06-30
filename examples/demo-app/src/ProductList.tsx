/**
 * ProductList — fetch-mock verification target for Easel #17 "Live State Puppeteer".
 *
 * On mount it calls `fetch('/api/products')`. By default no backend is running,
 * so the fetch will fail or 404 → the component lands in the error/empty state.
 * When a puppeteer fetch-mock intercepts `/api/products` and returns a JSON array,
 * the list renders the items straight from the response.
 *
 * Expected response shape:
 *   Array<{ id: number | string; name: string; price: number }>
 *
 * Try it:
 *   Enable State Puppeteer in Easel → ask "pretend /api/products returns 50 items"
 */

import React, { useEffect, useState } from 'react';

export interface Product {
  id: number | string;
  name: string;
  price: number;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'success'; products: Product[] };

export default function ProductList(): React.ReactElement {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/products');
        if (!res.ok) {
          if (!cancelled) setFetchState({ status: 'error', message: `HTTP ${res.status}` });
          return;
        }
        const data: unknown = await res.json();
        if (cancelled) return;

        if (!Array.isArray(data)) {
          setFetchState({ status: 'error', message: 'Unexpected response shape' });
          return;
        }

        if (data.length === 0) {
          setFetchState({ status: 'empty' });
        } else {
          setFetchState({ status: 'success', products: data as Product[] });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setFetchState({ status: 'error', message });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="puppeteer-panel">
      <div className="puppeteer-panel-header">
        <span className="puppeteer-label">fetch('/api/products')</span>
        <span className="puppeteer-badge">fetch-mock target</span>
      </div>

      {fetchState.status === 'loading' && (
        <p className="puppeteer-state-note">Loading…</p>
      )}

      {fetchState.status === 'error' && (
        <div className="puppeteer-empty-state">
          <p className="puppeteer-empty-heading">No products loaded</p>
          <p className="puppeteer-empty-body">
            Fetch returned an error ({fetchState.message}). Enable State Puppeteer in
            Easel and ask: <em>"pretend /api/products returns 50 items"</em>
          </p>
        </div>
      )}

      {fetchState.status === 'empty' && (
        <div className="puppeteer-empty-state">
          <p className="puppeteer-empty-heading">0 products</p>
          <p className="puppeteer-empty-body">The API returned an empty array.</p>
        </div>
      )}

      {fetchState.status === 'success' && (
        <ul className="product-list">
          {fetchState.products.map((p) => (
            <li key={p.id} className="product-row">
              <span className="product-name">{p.name}</span>
              <span className="product-price">${p.price.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
