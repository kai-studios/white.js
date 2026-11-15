# White.js

A thin web framework built on Express 5.

## Requirements

- Node.js 20.12 or newer
- Git, to install examples

## Run a project

Install White.js in your application and add these scripts to `package.json`:

```json
{
  "scripts": {
    "start": "white run",
    "dev": "white run dev"
  }
}
```

Then run `npm run dev` for development or `npm start` for production.

## Install an example

```sh
npm install white-js
npx white install example:site
cd site
npm install
npm run dev
```

Examples are installed into a new directory named after the example. Existing directories are never overwritten.
