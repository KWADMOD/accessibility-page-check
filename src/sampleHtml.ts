// A small page with deliberate, common accessibility mistakes. It is test and
// documentation data only (used by report.test.ts and the README sample), not a
// page anyone is meant to visit, so it is not itself held to WCAG.

export const SAMPLE_BROKEN_HTML = `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
</head>
<body>
  <h2>Welcome to Acme Dental</h2>
  <!-- Enough readable text (150+ characters) that the scan does not add its "almost no text" warning, so the README sample matches real output. -->
  <p>We are a family dental practice offering checkups, cleanings, whitening and emergency care. Call us or book online to find a time that suits you this week.</p>
  <img src="/team.jpg">
  <img src="/office.jpg">
  <img src="/logo.png" alt="Acme Dental logo">
  <a href="/book"><img src="/book-icon.png"></a>
  <h4>Our services</h4>
  <form>
    <input type="text" name="name">
    <input type="email" placeholder="Your email">
    <button><img src="/arrow.svg"></button>
  </form>
</body>
</html>`;
