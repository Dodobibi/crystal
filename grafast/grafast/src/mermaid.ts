/*
 * This file contains all our utilities for dealing with Mermaid-js
 */

import {
  GrafastPlanBucketJSONv1,
  GrafastPlanJSON,
  GrafastPlanJSONv1,
  GrafastPlanStepJSONv1,
} from "./interfaces";
import { __ItemStep, __ListTransformStep } from "./steps/index.js";
import { stripAnsi } from "./stripAnsi.js";

/**
 * An array of hex colour codes that we use for colouring the buckets/steps in
 * the mermaid-js plan diagram.
 *
 * Generated by mokole.com/palette.html; re-ordered by Jem
 */
export const COLORS = [
  "#696969",
  "#00bfff",
  "#7f007f",
  "#ffa500",
  "#0000ff",
  "#7fff00",
  "#ff1493",
  "#808000",
  "#dda0dd",
  "#ff0000",
  "#ffff00",
  "#00ffff",
  "#4169e1",
  "#3cb371",
  "#a52a2a",
  "#ff00ff",
  "#f5deb3",
];

/**
 * Given a string, escapes the string so that it can be embedded as the description of a node in a mermaid chart.
 *
 * 1. If it's already safe, returns it verbatim
 * 2. If it contains disallowed characters, escape them by replacing them with similar-looking characters,
 * 3. Wrap the string in quote marks.
 *
 * @remarks
 *
 * NOTE: rather than doing literal escapes, we replace with lookalike characters because:
 *
 * 1. Mermaid has a bug when calculating the width of the node that doesn't respect escapes,
 * 2. It's easier to read the raw mermaid markup with substitutes rather than messy escapes.
 *
 * @internal
 */
export const mermaidEscape = (str: string): string => {
  if (str.match(/^[a-z0-9 ]+$/i)) {
    return str;
  }
  // Technically we should replace with escapes like this:
  //.replace(/[#"]/g, (l) => ({ "#": "#35;", '"': "#quot;" }[l as any]))
  // However there's a bug in Mermaid's rendering that causes the node to use
  // the escaped string as the width for the node rather than the unescaped
  // string. Thus we replace with similar looking characters.
  return `"${stripAnsi(str.trim())
    .replace(
      /[#"<>]/g,
      (l) =>
        ({ "#": "ꖛ", '"': "”", "<": "ᐸ", ">": "ᐳ" })[
          l as "#" | '"' | "<" | ">"
        ],
    )
    .replace(/\r?\n/g, "<br />")}"`;
};

export interface PrintPlanGraphOptions {
  printPathRelations?: boolean;
  includePaths?: boolean;
  concise?: boolean;
  skipBuckets?: boolean;
}

function isGrafastPlanJSONv1(json: GrafastPlanJSON): json is GrafastPlanJSONv1 {
  return json.version === "v1";
}

export function planToMermaid(
  planJSON: GrafastPlanJSON,
  {
    // printPathRelations = false,
    concise = false,
    skipBuckets = (global as any).grafastExplainMermaidSkipBuckets ?? false,
  }: PrintPlanGraphOptions = {},
): string {
  if (!isGrafastPlanJSONv1(planJSON)) {
    throw new Error("planToMermaid only supports v1 plan JSON");
  }

  const stepById: { [stepId: number | string]: GrafastPlanStepJSONv1 } =
    Object.create(null);
  const layerPlanById: {
    [layerPlanId: number | string]: GrafastPlanBucketJSONv1;
  } = Object.create(null);
  const dependentsByStepId: {
    [stepId: string | number]: GrafastPlanStepJSONv1[] | undefined;
  } = Object.create(null);
  const sortedSteps: GrafastPlanStepJSONv1[] = [];
  const extractSteps = (bucket: GrafastPlanBucketJSONv1): void => {
    layerPlanById[bucket.id] = bucket;
    // Shallowest bucket first, then most dependencies
    const sorted = [...bucket.steps].sort(
      (a, z) => z.dependencyIds.length - a.dependencyIds.length,
    );
    for (const step of sorted) {
      if (stepById[step.id]) {
        throw new Error(
          `Step ${step.id} (${step.stepClass}/${step.metaString}) duplicated in plan?!`,
        );
      }
      stepById[step.id] = step;
      sortedSteps.push(step);
      for (const depId of step.dependencyIds) {
        if (!dependentsByStepId[depId]) {
          dependentsByStepId[depId] = [step];
        } else {
          dependentsByStepId[depId]!.push(step);
        }
      }
    }
    for (const child of bucket.children) {
      extractSteps(child);
    }
  };
  extractSteps(planJSON.rootBucket);

  const color = (i: number) => {
    return COLORS[i % COLORS.length];
  };

  const planStyle = `fill:#fff,stroke-width:1px,color:#000`;
  const itemplanStyle = `fill:#fff,stroke-width:2px,color:#000`;
  const unbatchedplanStyle = `fill:#dff,stroke-width:1px,color:#000`;
  const sideeffectplanStyle = `fill:#fcc,stroke-width:2px,color:#000`;
  const graph = [
    `%%{init: {'themeVariables': { 'fontSize': '12px'}}}%%`,
    `${concise ? "flowchart" : "graph"} TD`,
    `    classDef path fill:#eee,stroke:#000,color:#000`,
    `    classDef plan ${planStyle}`,
    `    classDef itemplan ${itemplanStyle}`,
    `    classDef unbatchedplan ${unbatchedplanStyle}`,
    `    classDef sideeffectplan ${sideeffectplanStyle}`,
    `    classDef bucket fill:#f6f6f6,color:#000,stroke-width:2px,text-align:left`,
    ``,
  ];

  const squish = (str: string, start = 8, end = 8): string => {
    if (str.length > start + end + 4) {
      return `${str.slice(0, start)}...${str.slice(str.length - end)}`;
    }
    return str;
  };

  const planIdMap = Object.create(null);
  const planId = (plan: GrafastPlanStepJSONv1): string => {
    if (!planIdMap[plan.id]) {
      const planName = plan.stepClass.replace(/Step$/, "");
      const planNode = `${planName}${plan.id}`;
      planIdMap[plan.id] = planNode;
      const rawMeta = plan.metaString;
      const strippedMeta = rawMeta != null ? stripAnsi(rawMeta) : null;
      const meta =
        concise && strippedMeta ? squish(strippedMeta) : strippedMeta;
      const isUnbatched = plan.supportsUnbatched;

      const polyPaths = pp(plan.polymorphicPaths);
      const polyPathsIfDifferent =
        plan.dependencyIds.length === 1 &&
        pp(stepById[plan.dependencyIds[0]].polymorphicPaths) === polyPaths
          ? ""
          : `\n${polyPaths}`;

      const planString = `${planName}[${plan.id}${`∈${plan.bucketId}`}]${
        meta ? `\n<${meta}>` : ""
      }${polyPathsIfDifferent}`;
      const [lBrace, rBrace] =
        plan.stepClass === "__ItemStep"
          ? ["[/", "\\]"]
          : plan.isSyncAndSafe
          ? isUnbatched
            ? ["{{", "}}"]
            : ["[", "]"]
          : ["[[", "]]"];
      const planClass = plan.hasSideEffects
        ? "sideeffectplan"
        : plan.stepClass === "__ItemStep"
        ? "itemplan"
        : isUnbatched && !plan.isSyncAndSafe
        ? "unbatchedplan"
        : "plan";
      graph.push(
        `    ${planNode}${lBrace}${mermaidEscape(
          planString,
        )}${rBrace}:::${planClass}`,
      );
    }
    return planIdMap[plan.id];
  };

  graph.push("");
  graph.push("    %% plan dependencies");
  const chainByDep: { [depNode: string]: string } = Object.create(null);

  sortedSteps.forEach(
    // This comment is here purely to maintain the previous formatting to reduce a git diff.
    (plan) => {
      const planNode = planId(plan);
      const depNodes = plan.dependencyIds.map((depId) => {
        return planId(stepById[depId]);
      });
      const transformItemPlanNode = null;
      /*
      plan.stepClass === '__ListTransformStep'
        ? planId(
            steps[operationPlan.transformDependencyPlanIdByTransformStepId[plan.id]],
          )
        : null;
        */
      if (depNodes.length > 0) {
        if (plan.stepClass === "__ItemStep") {
          const [firstDep, ...rest] = depNodes;
          const arrow = plan.extra?.transformStepId == null ? "==>" : "-.->";
          graph.push(`    ${firstDep} ${arrow} ${planNode}`);
          if (rest.length > 0) {
            graph.push(`    ${rest.join(" & ")} --> ${planNode}`);
          }
        } else {
          if (
            concise &&
            !dependentsByStepId[plan.id] &&
            depNodes.length === 1
          ) {
            // Try alternating the nodes so they render closer together
            const depNode = depNodes[0];
            if (chainByDep[depNode] === undefined) {
              graph.push(`    ${depNode} --> ${planNode}`);
            } else {
              graph.push(`    ${chainByDep[depNode]} o--o ${planNode}`);
            }
            chainByDep[depNode] = planNode;
          } else {
            graph.push(`    ${depNodes.join(" & ")} --> ${planNode}`);
          }
        }
      }
      if (transformItemPlanNode) {
        graph.push(`    ${transformItemPlanNode} -.-> ${planNode}`);
      }
      return plan;
    },
  );

  graph.push("");
  graph.push("    %% define steps");
  sortedSteps.forEach((step) => {
    planId(step);
  });

  const stepToString = (step: GrafastPlanStepJSONv1): string => {
    return `${step.stepClass.replace(/Step$/, "")}${
      step.bucketId === 0 ? "" : `{${step.bucketId}}`
    }${step.metaString ? `<${step.metaString}>` : ""}[${step.id}]`;
  };

  graph.push("");
  if (!concise) graph.push("    subgraph Buckets");
  const layerPlans = Object.values(layerPlanById);
  for (let i = 0, l = layerPlans.length; i < l; i++) {
    const layerPlan = layerPlans[i];
    if (!layerPlan || layerPlan.id !== i) {
      continue;
    }
    const plansAndIds = Object.entries(stepById).filter(
      ([id, plan]) =>
        plan && plan.id === Number(id) && plan.bucketId === layerPlan.id,
    );
    const raisonDEtre =
      ` (${layerPlan.reason.type})` +
      (layerPlan.reason.type === "polymorphic"
        ? `\n${layerPlan.reason.typeNames}`
        : ``);
    const outputMapStuff: string[] = [];
    if (!skipBuckets) {
      graph.push(
        `    Bucket${layerPlan.id}(${mermaidEscape(
          `Bucket ${layerPlan.id}${raisonDEtre}${
            layerPlan.copyStepIds.length > 0
              ? `\nDeps: ${layerPlan.copyStepIds
                  .map((pId) => stepById[pId]!.id)
                  .join(", ")}\n`
              : ""
          }${
            layerPlan.reason.type === "polymorphic"
              ? pp(layerPlan.reason.polymorphicPaths)
              : ""
          }${
            layerPlan.rootStepId != null && layerPlan.reason.type !== "root"
              ? `\nROOT ${stepToString(stepById[layerPlan.rootStepId])}`
              : ""
          }${startSteps(layerPlan)}\n${outputMapStuff.join("\n")}`,
        )}):::bucket`,
      );
    }
    graph.push(
      `    classDef bucket${layerPlan.id} stroke:${color(layerPlan.id)}`,
    );
    graph.push(
      `    class ${[
        `Bucket${layerPlan.id}`,
        ...plansAndIds.map(([, plan]) => planId(plan!)),
      ].join(",")} bucket${layerPlan.id}`,
    );
  }
  if (!skipBuckets) {
    for (let i = 0, l = layerPlans.length; i < l; i++) {
      const layerPlan = layerPlans[i];
      if (!layerPlan || layerPlan.id !== i) {
        continue;
      }
      const childNodes = layerPlan.children.map((c) => `Bucket${c.id}`);
      if (childNodes.length > 0) {
        graph.push(`    Bucket${layerPlan.id} --> ${childNodes.join(" & ")}`);
      }
    }
  }
  if (!concise) graph.push("    end");

  const graphString = graph.join("\n");
  return graphString;
  function startSteps(layerPlan: GrafastPlanBucketJSONv1) {
    function shortStep(step: GrafastPlanStepJSONv1) {
      return `${step.stepClass.replace(/Step$/, "") ?? ""}[${step.id}]`;
    }
    function shortSteps(
      steps: ReadonlyArray<GrafastPlanStepJSONv1> | undefined,
    ) {
      if (!steps) {
        return "";
      }
      const str = steps.map(shortStep).join(", ");
      if (str.length < 40) {
        return str;
      } else {
        return steps.map((s) => s.id).join(", ");
      }
    }
    return layerPlan.phases.length === 1
      ? ``
      : `\n${layerPlan.phases
          .map(
            (phase, i) =>
              `${i + 1}: ${shortSteps(
                phase.normalStepIds?.map((id) => stepById[id]),
              )}${
                phase.unbatchedStepIds
                  ? `\n>: ${shortSteps(
                      phase.unbatchedStepIds.map((id) => stepById[id]),
                    )}`
                  : ""
              }`,
          )
          .join("\n")}`;
  }
}

function pp(polymorphicPaths: ReadonlyArray<string> | null | undefined) {
  if (!polymorphicPaths) {
    return "";
  }
  return polymorphicPaths.map((p) => `${p}`).join("\n");
}
