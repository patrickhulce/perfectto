# perfectto

Perfetto perfected.

A minimal static React app for previewing text-based performance trace files. Built with Vite, styled with Tailwind CSS v4, and tested with Jest.

## Stack

- [React 19](https://react.dev/)
- [Vite](https://vitejs.dev/) (dev server + static build)
- [Tailwind CSS v4](https://tailwindcss.com/) via the first-party Vite plugin
- [Jest](https://jestjs.io/) + [@testing-library/react](https://testing-library.com/) + [`@swc/jest`](https://github.com/swc-project/jest) (no Babel)

## Getting started

```bash
npm install
npm run dev      # start the Vite dev server
npm test         # run the Jest suite
npm run build    # produce a static build in dist/
npm run preview  # preview the production build locally
```

## Project layout

```
.
├── index.html          # Vite entry
├── vite.config.js
├── jest.setup.js       # pulls in @testing-library/jest-dom
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css       # @import "tailwindcss";
    ├── components/
    │   ├── Splash.jsx
    │   └── Viewer.jsx
    ├── utils/
    │   ├── formatBytes.js
    │   └── loadFile.js
    └── __tests__/
        ├── formatBytes.test.js
        ├── Splash.test.jsx
        └── App.test.jsx
```

Jest config lives inline in `package.json` under the `"jest"` key.
