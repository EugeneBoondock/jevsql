import { probability, validateAnswer } from './validation.mjs';

const DEFAULT = '__default__';
const UNKNOWN = '__unknown__';

function registryEntries(functions) {
  if (!functions || typeof functions !== 'object' || Array.isArray(functions)) {
    throw new TypeError('functions must be a registered function map.');
  }
  const entries = Object.entries(functions);
  if (!entries.length || entries.length > 254) throw new TypeError('Register 1 to 254 functions.');
  for (const [name, definition] of entries) {
    if (!name || !definition || typeof definition !== 'object' || typeof definition.description !== 'string' || !definition.description.trim()) {
      throw new TypeError('Every registered function needs a name and description.');
    }
    if (definition.run != null && typeof definition.run !== 'function') throw new TypeError(`Function ${name} run must be callable.`);
  }
  return entries;
}

function choice(question, task, options) {
  return { type: 'choice', instructions: { question, task }, criteria: Object.fromEntries(options) };
}

function selected(answer, labels, minProbability) {
  validateAnswer(answer, { kind: 'choice', criteria: labels });
  return answer.probabilities[answer.choice] >= minProbability ? answer.choice : null;
}

/** Select one registered function and closed-set arguments, then optionally run it. */
export async function routeApprovedFunction({ client, state, request, functions, minProbability = 0.8,
  execute = false, confirm, signal } = {}) {
  if (!client || typeof client.evaluate !== 'function') throw new TypeError('routeApprovedFunction needs a TypeSafe client.');
  probability(minProbability, 'minProbability');
  const entries = registryEntries(functions);
  const functionOptions = [...entries.map(([name, definition]) => [name, definition.description]),
    [UNKNOWN, 'No registered function safely satisfies the request.']];
  const routed = await client.evaluate(state, {
    function: choice(request, 'Choose one registered function. Select unknown when none safely fits.', functionOptions),
  }, { signal });
  const name = selected(routed.answers?.function, functionOptions.map(([label]) => label), minProbability);
  if (!name || name === UNKNOWN) return { status: 'review', reason: name ? 'no_function' : 'low_function_probability', function: null, args: null };

  const definition = functions[name];
  const specs = definition.args ?? {};
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) throw new TypeError(`Function ${name} args must be an object.`);
  const questions = {};
  const normalized = {};
  for (const [argName, spec] of Object.entries(specs)) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.options) || !spec.options.length || spec.options.length > 253) {
      throw new TypeError(`Argument ${argName} must define 1 to 253 closed options.`);
    }
    const options = spec.options.map((value) => String(value));
    if (new Set(options).size !== options.length || options.includes(DEFAULT) || options.includes(UNKNOWN)) {
      throw new TypeError(`Argument ${argName} options must be distinct and cannot use reserved labels.`);
    }
    const pairs = options.map((value) => [value, null]);
    if (Object.hasOwn(spec, 'default')) pairs.push([DEFAULT, `Use the registered default: ${String(spec.default)}`]);
    pairs.push([UNKNOWN, 'The request does not state a supported value.']);
    normalized[argName] = { ...spec, options, labels: pairs.map(([label]) => label) };
    questions[argName] = choice(request, `Choose the ${argName} argument for ${name}. Use default when unstated and a registered default exists.`, pairs);
  }

  const args = {};
  if (Object.keys(questions).length) {
    const response = await client.evaluate(state, questions, { signal });
    for (const [argName, spec] of Object.entries(normalized)) {
      const value = selected(response.answers?.[argName], spec.labels, minProbability);
      if (!value) return { status: 'review', reason: `low_argument_probability:${argName}`, function: name, args: null };
      if (value === DEFAULT) args[argName] = spec.default;
      else if (value === UNKNOWN) {
        if (Object.hasOwn(spec, 'default')) args[argName] = spec.default;
        else return { status: 'review', reason: `missing_argument:${argName}`, function: name, args: null };
      } else args[argName] = spec.options[spec.options.indexOf(value)];
    }
  }

  const call = { function: name, args };
  if (!execute) return { status: definition.sideEffect ? 'confirmation_required' : 'ready', ...call };
  if (definition.sideEffect) {
    if (typeof confirm !== 'function' || await confirm(call) !== true) {
      return { status: 'confirmation_required', ...call };
    }
  }
  if (typeof definition.run !== 'function') return { status: 'ready', ...call };
  const output = await definition.run(args);
  return { status: 'executed', ...call, output };
}
