// Plain-English text for each rule. checks.ts decides WHAT is wrong; this file
// says what it means for a real person and how to fix it, so the report reads
// like advice from a colleague instead of a rule dump. One entry per ruleId, and
// a test fails if a rule is added to checks.ts without an entry here.

export interface RuleInfo {
  title: string;
  wcagName: string;
  meaning: string;
  fix: string;
  /**
   * True when WCAG does not itself require this (axe and WAVE class it as a best practice).
   * The report then says so, instead of calling it a WCAG failure a stranger could dispute.
   */
  bestPractice?: boolean;
}

export const RULE_INFO: Record<string, RuleInfo> = {
  "html-lang": {
    title: "Page language is not declared",
    wcagName: "Language of Page",
    meaning: "Screen readers use the page language to pick a voice and pronunciation. Without it, text can be read in the wrong accent or gibberish.",
    fix: 'Add a lang attribute to the <html> tag, for example <html lang="en">.',
  },
  "page-title": {
    title: "Page has no title",
    wcagName: "Page Titled",
    meaning: "The title is the first thing a screen reader announces and the label on browser tabs, bookmarks and search results.",
    fix: "Add a short, specific <title> inside <head>, for example \"Contact us - Acme Dental\".",
  },
  "img-alt": {
    title: "Images are missing alt text",
    wcagName: "Non-text Content",
    meaning: "People using screen readers get no description of the image, or hear the file name read aloud.",
    fix: 'Add alt text that says what the image is for. If it is purely decorative, use an empty alt="".',
  },
  "link-name": {
    title: "Links have no readable name",
    wcagName: "Link Purpose (In Context)",
    meaning: 'A screen reader can only say "link", so the person cannot tell where it goes.',
    fix: "Give each link visible text, or an aria-label, or an image inside it that has alt text.",
  },
  "button-name": {
    title: "Buttons have no readable name",
    wcagName: "Name, Role, Value",
    meaning: 'A screen reader announces only "button", so the person cannot tell what it does. Voice-control users cannot say its name either.',
    fix: "Put visible text in the button, or add an aria-label that says what it does.",
  },
  "form-label": {
    title: "Form fields have no label",
    wcagName: "Info and Relationships",
    meaning: "People using screen readers or voice control cannot tell what to type, and clicking the visible text does not focus the field.",
    fix: 'Connect a <label for="field-id"> to the field, or wrap the field in a <label>.',
  },
  "placeholder-label": {
    title: "Form fields are labelled only by placeholder text",
    wcagName: "Labels or Instructions",
    meaning: "Placeholder text disappears as soon as someone starts typing, so people who are interrupted or have memory difficulties lose track of what the field wants. It is also often too faint to read.",
    fix: 'Add a visible <label for="field-id"> above the field. The placeholder can stay as an example.',
    bestPractice: true,
  },
  "heading-h1": {
    title: "Page has headings but no main heading (h1)",
    wcagName: "Info and Relationships",
    meaning: "Screen reader users move around a page by its headings. Without an h1 there is no clear statement of what the page is about.",
    fix: "Make the page's main title an <h1>.",
    bestPractice: true,
  },
  "heading-order": {
    title: "Heading levels are skipped",
    wcagName: "Info and Relationships",
    meaning: "Jumping from h2 to h4 makes the page outline confusing for people who navigate by headings.",
    fix: "Step down one level at a time (h2, then h3). Choose levels for structure, not for font size.",
    bestPractice: true,
  },
  "meta-viewport-zoom": {
    title: "Zooming is blocked on phones and tablets",
    wcagName: "Resize Text",
    meaning: "People with low vision rely on pinch-zoom to read. Blocking it can make the page unusable for them.",
    fix: 'Remove user-scalable=no and any maximum-scale below 2 from the <meta name="viewport"> tag.',
  },
};

/** Honest list of what a scan of raw HTML cannot see. Shown in every report. */
export const NOT_CHECKED: string[] = [
  "Color contrast between text and background",
  "Keyboard use: tab order, focus visibility and keyboard traps",
  "Content added by JavaScript after the page loads",
  "Captions and transcripts for video and audio",
  "Whether alt text and labels are actually helpful, only that they exist",
  "Correct use of ARIA, form error messages and timing",
  "Any page other than the one you gave",
];
