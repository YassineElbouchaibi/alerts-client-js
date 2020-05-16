# Release Notes

## 4.0.1
**Initial Public Release**

* **Visibility**
  * GitHub repository's access level changed to public.
  * Published to NPM as a [public package](https://www.npmjs.com/package/@barchart/alerts-client-js).
  * MIT License applied.
* **Documentation**
  * [JSDoc](https://jsdoc.app/) completed and updated in code files.
  * [OpenAPI](https://www.openapis.org/) definition added.
  * Documentation site [published to GitHub Pages](https://barchart.github.io/alerts-client-js/).
* **Breaking Changes**
  * All environments now require JSON Web Tokens (JWT) for authentication and authorization.
  * The ```JwtProvider``` class has been refactored and moved.
  * The ```AlertManager``` constructor now requires an ```AdapterBase``` (specifies HTTP or WebSocket).

