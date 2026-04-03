/**
 * graph.ts — The Agent Graph (State Machine)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONCEPT: WHAT IS A STATE MACHINE / GRAPH?
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * A graph is a set of NODES connected by EDGES.
 *
 * NODE  = an agent (a function that transforms state)
 * EDGE  = a connection between nodes (always goes A → B)
 * CONDITIONAL EDGE = a connection that chooses the next node
 *                    based on the current state value
 *
 * Our graph:
 *
 *   [START]
 *      │
 *      ▼
 *   [orchestrator]  ← classifies question, rewrites queries
 *      │
 *      ▼
 *   [retrieval]     ← parallel search, deduplication
 *      │
 *      ▼
 *   [critic]        ← generate answer + evaluate faithfulness
 *      │
 *      ├── criticPass=true  ──────────────────────► [END]
 *      │
 *      └── criticPass=false + retries left ──────► [retrieval]  (loop back)
 *      │
 *      └── criticPass=false + max retries ────────► [END]
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MANUAL vs LANGGRAPH — SIDE BY SIDE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * MANUAL (what we implement below):
 *   - You write the loop yourself (while loop)
 *   - You call each node function manually
 *   - You merge state manually (Object.assign)
 *   - You implement routing with if/else
 *   PRO: Zero dependencies, full transparency
 *   CON: No streaming, no checkpointing, no visualization
 *
 * LANGGRAPH (commented out below — see LANGGRAPH MIGRATION section):
 *   - You define nodes + edges declaratively
 *   - LangGraph runs the loop for you
 *   - State merging is automatic (each node returns a patch)
 *   - Routing is a first-class concept (addConditionalEdges)
 *   - BONUS: Built-in streaming, checkpointing, visualization
 *   PRO: Production-ready, resumable, streamable
 *   CON: More setup, requires understanding the framework
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * KEY LEARNING: What LangGraph gives you for FREE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. CHECKPOINTING — save graph state to DB after each node
 *    If server crashes mid-graph, resume from last checkpoint
 *    Manual: you'd need to implement this yourself
 *
 * 2. STREAMING — emit state updates as each node completes
 *    UI can show "Orchestrator done... Retrieving... Generating..."
 *    Manual: you'd need WebSockets + manual event emission
 *
 * 3. VISUALIZATION — LangSmith shows the graph as a diagram
 *    You can see exactly which path each request took
 *    Manual: you'd need to build your own logging dashboard
 *
 * 4. HUMAN-IN-THE-LOOP — pause graph and wait for human approval
 *    Example: "Critic failed 2 times — should I continue?"
 *    Manual: very complex to implement
 */

import { AgentState, createInitialState } from "./state";
import { orchestratorNode } from "./orchestrator";
import { retrievalNode } from "./retrieval";
import { criticNode, criticRouter } from "./critic";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1: MANUAL STATE MACHINE (no framework)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Runs the full agent graph manually
 * This is the "no framework" implementation — every step is explicit
 *
 * @param question  - User's question
 * @param sessionId - Session ID for memory
 * @param memory    - Pre-formatted memory string from summarizer
 * @returns         - Final agent state with answer, citations, followUpQuestions
 *
 * Execution trace example:
 *   "What is RAG and how does chunking work?"
 *   → orchestrator: route=complex, queries=["What is RAG?", "How does chunking work?"]
 *   → retrieval: 8 raw chunks → 6 unique chunks after dedup
 *   → critic attempt 1: score=8 → PASS
 *   → return answer with 6 citations
 */
export async function runAgentGraph(
  question: string,
  sessionId: string,
  memory: string
): Promise<AgentState> {

  // Initialize state — the "baton" that flows through all nodes
  let state: AgentState = createInitialState(question, sessionId, memory);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`[graph] Starting agent graph for: "${question}"`);
  console.log(`${"═".repeat(60)}`);

  // ── Node 1: Orchestrator ──────────────────────────────────────
  // Classifies question + rewrites queries
  // Manual: we call the function and merge the result into state
  // LangGraph: this happens automatically when graph reaches "orchestrator" node
  console.log(`\n[graph] ── Node: orchestrator ──`);
  const orchestratorUpdate = await orchestratorNode(state);
  state = { ...state, ...orchestratorUpdate }; // manual state merge

  // ── Retrieval + Critic Loop ───────────────────────────────────
  // This loop implements the retry pattern:
  //   retrieve → generate → critique → retry if needed
  //
  // Manual: explicit while loop with a "next" variable
  // LangGraph: addConditionalEdges("critic", criticRouter) handles this automatically
  let next: "retrieval" | "end" = "retrieval";

  while (next === "retrieval") {

    // ── Node 2: Retrieval ───────────────────────────────────────
    console.log(`\n[graph] ── Node: retrieval ──`);
    const retrievalUpdate = await retrievalNode(state);
    state = { ...state, ...retrievalUpdate };

    // ── Node 3: Critic ──────────────────────────────────────────
    // Generates answer AND evaluates it in one node
    console.log(`\n[graph] ── Node: critic ──`);
    const criticUpdate = await criticNode(state);
    state = { ...state, ...criticUpdate };

    // ── Conditional Edge: where to go next? ─────────────────────
    // Manual: call criticRouter() ourselves and check the result
    // LangGraph: addConditionalEdges("critic", criticRouter, { end: END, retrieval: "retrieval" })
    next = criticRouter(state);
    console.log(`\n[graph] ── Edge: critic → ${next} ──`);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[graph] Graph complete. Score: ${state.criticScore}/10, Retries: ${state.retryCount - 1}`);
  console.log(`${"═".repeat(60)}\n`);

  return state;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2: LANGGRAPH MIGRATION (commented out — study this!)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Compare the manual implementation above with LangGraph below.
// Notice how LangGraph replaces:
//   - The while loop          → addConditionalEdges()
//   - Manual state merge      → automatic (each node returns a patch)
//   - Manual node calls       → graph.invoke() runs everything
//
// To activate: uncomment this block and comment out runAgentGraph above
// Requires: npm install @langchain/langgraph @langchain/core
//
// import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
//
// // LangGraph state definition — same fields as our AgentState interface
// // Annotation.Root tells LangGraph how to MERGE state updates from each node
// const LangGraphState = Annotation.Root({
//   question:           Annotation<string>(),
//   sessionId:          Annotation<string>(),
//   memory:             Annotation<string>(),
//   route:              Annotation<string>(),
//   queries:            Annotation<string[]>(),
//   contexts:           Annotation<string[]>(),
//   citations:          Annotation<any[]>(),
//   answer:             Annotation<string>(),
//   followUpQuestions:  Annotation<string[]>(),
//   criticPass:         Annotation<boolean>(),
//   criticScore:        Annotation<number>(),
//   retryCount:         Annotation<number>(),
// });
//
// // Build the graph declaratively — much cleaner than the while loop above
// const langGraph = new StateGraph(LangGraphState)
//   // Register nodes (same functions we wrote above!)
//   .addNode("orchestrator", orchestratorNode)
//   .addNode("retrieval",    retrievalNode)
//   .addNode("critic",       criticNode)
//
//   // Define edges (the flow between nodes)
//   .addEdge(START, "orchestrator")          // always start with orchestrator
//   .addEdge("orchestrator", "retrieval")    // always go to retrieval after orchestrator
//
//   // Conditional edge — LangGraph calls criticRouter(state) to decide next node
//   // This REPLACES our entire while loop above
//   .addConditionalEdges("critic", criticRouter, {
//     "end":       END,          // criticPass=true or max retries → finish
//     "retrieval": "retrieval",  // criticPass=false → loop back to retrieval
//   })
//   .compile();
//
// // LangGraph version of runAgentGraph
// export async function runAgentGraphLangGraph(
//   question: string,
//   sessionId: string,
//   memory: string
// ): Promise<AgentState> {
//   const initialState = createInitialState(question, sessionId, memory);
//
//   // invoke() runs the entire graph — no manual loop needed
//   // LangGraph handles: node execution, state merging, conditional routing
//   const finalState = await langGraph.invoke(initialState);
//   return finalState as AgentState;
// }
