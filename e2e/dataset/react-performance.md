# React Performance Tuning — Notion Notes

Notes from reading the React docs and various blog posts on optimising React applications.

## Core Techniques

### Memoization with React.memo
Wrap components that receive stable props to prevent unnecessary re-renders. Best for pure presentational components.

### useCallback for Stable References
Use `useCallback` when passing callbacks as props to memoized child components. Without it, a new function reference is created on every render, defeating `React.memo`.

### useMemo for Expensive Computations
Cache the result of expensive calculations. Only recompute when dependencies change.

## Profiling with React DevTools

The React DevTools Profiler (browser extension) records renders and highlights components that re-render unnecessarily. Essential for diagnosing performance issues in production builds.

## Code Splitting

Use `React.lazy` with `Suspense` for route-based code splitting. Reduces initial bundle size significantly.

## Virtual Lists

For long lists (100+ items), use `react-window` or `react-virtual` to only render visible items.

Tags: react, performance, memoization, useCallback, useMemo, devtools, frontend, javascript
