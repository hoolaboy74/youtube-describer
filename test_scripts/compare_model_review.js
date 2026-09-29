'use strict';

// Same CLI/assets/providers as compare_model.js; each model reviews its own draft
// in a separate API call. Never publishes either stage to the application DB.
const fs = require('node:fs/promises');
const path = require('node:path');
const { main: compareMain, usage, generateModel, countLines } = require('./compare_model');

function buildReviewPrompt(policy, draft, instructions) {
  return `${instructions}\n\n# 집필 정책과 원본 문맥\n${policy}\n\n# 검수 대상 초안 (JSON 문자열 데이터)\n${JSON.stringify(draft)}\n\n초안의 주장을 그대로 믿지 말고 이후 각 이미지와 Timestamp로 대조하십시오. 수정된 전체 대본만 출력하십시오.`;
}

async function generateReviewed({ run, input, runDir }, call = generateModel) {
  const stem = run.outputFile.replace(/\.txt$/, '');
  const draftFile = `${stem}.draft.txt`;
  const stageFile = `${stem}.stages.json`;
  const reviewPromptFile = `${stem}.review-prompt.txt`;
  const stages = { status: 'draft_running', draftFile, reviewPromptFile, draft: null, review: null };
  let activeStage = 'draft';
  const saveStages = () => fs.writeFile(path.join(runDir, stageFile), JSON.stringify(stages, null, 2));
  // Read before making a paid call, so a missing review template fails early.
  const instructions = await fs.readFile(path.join(__dirname, 'review_prompt.txt'), 'utf8');
  await saveStages();
  try {
    const draft = await call(run, input.policy.prompt, input.frames);
    await fs.writeFile(path.join(runDir, draftFile), draft.text, 'utf8');
    stages.draft = { ...draft, summary: countLines(draft.text) };
    await saveStages();
    if (!draft.text.trim()) throw new Error('Draft is empty; review was not called.');
    const reviewPrompt = buildReviewPrompt(input.policy.prompt, draft.text, instructions);
    await fs.writeFile(path.join(runDir, reviewPromptFile), reviewPrompt, 'utf8');
    activeStage = 'review';
    stages.status = 'review_running';
    await saveStages();
    const review = await call(run, reviewPrompt, input.frames);
    stages.review = { ...review, summary: countLines(review.text) };
    if (!review.text.trim()) throw new Error('Review is empty; no final script is published.');
    stages.status = 'completed';
    await saveStages();
    return {
      ...review,
      mode: 'draft_then_review',
      draftFile,
      stageFile,
      reviewPromptFile,
      durationMs: draft.durationMs + review.durationMs,
      // Preserve provider-native token fields separately; never label review-only
      // tokens as the total cost of the two-call workflow.
      usage: { draft: draft.usage, review: review.usage },
      stages: { draft: stages.draft, review: stages.review }
    };
  } catch (error) {
    stages.status = `${activeStage}_failed`;
    stages.error = error.stack || String(error);
    await saveStages();
    throw error; // Never substitute the unreviewed draft for the final result.
  }
}

async function main(argv = process.argv.slice(2)) {
  return compareMain(argv, {
    mode: 'draft_then_review',
    runPrefix: 'review-',
    help: usage().replaceAll('compare_model.js', 'compare_model_review.js')
      + '\n\nEach selected model generates a draft and then reviews it using the same model/settings.\n'
      + '-p selects the drafting policy, also supplied to review. Review rules: review_prompt.txt.\n'
      + 'Outputs: MODEL.draft.txt, MODEL.txt (reviewed), MODEL.stages.json, result.json.\n'
      + 'Two model calls per successful model run; usage is saved separately for each stage.',
    generate: generateReviewed
  });
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});

module.exports = { main, generateReviewed, buildReviewPrompt };
