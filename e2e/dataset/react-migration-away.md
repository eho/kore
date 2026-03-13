# Why We Are Moving Away from React

Internal Architecture Memo.

After three years of building our frontend infrastructure with React and Next.js, the engineering team has decided to completely drop the framework.

## The Problems with React

We have encountered severe performance bottlenecks related to React's rendering lifecycle. The need to constantly wrap components in `useMemo` and `useCallback` to prevent cascading re-renders has led to incredibly brittle and hard-to-read code. Furthermore, the `useEffect` hook has been a constant source of bugs and race conditions for junior developers.

The mental overhead required to write highly performant React code is simply too high for our current team velocity.

## The Migration Plan

We are migrating our entire stack to Vue 3 and Nuxt. 

Vue's Composition API and reactivity system (via Signals) provides a much more intuitive and performant developer experience out of the box. We don't have to manually manage dependency arrays, and the built-in reactivity means components only re-render when they absolutely need to.

We will begin rewriting the legacy React components starting in Q2. No new features should be built using React.

Tags: frontend, architecture, migration, javascript, engineering
