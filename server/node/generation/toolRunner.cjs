'use strict';

const SERVER_SAFE_TOOL_NAMES = new Set(['rollDice']);

function selectServerTools(requestedTools) {
    const tools = Array.isArray(requestedTools) ? requestedTools : [];
    const safeTools = [];
    const unsupportedTools = [];
    for (const tool of tools) {
        if (!tool?.name) {
            continue;
        }
        if (SERVER_SAFE_TOOL_NAMES.has(tool.name)) {
            safeTools.push(tool);
        } else {
            unsupportedTools.push(tool.name);
        }
    }
    return { safeTools, unsupportedTools };
}

async function executeToolCall(name, args) {
    switch (name) {
        case 'rollDice':
            return [{ type: 'text', text: formatDiceResult(args?.notation || 'd20') }];
        default:
            throw new Error(`Unsupported server tool: ${name}`);
    }
}

function formatDiceResult(notation) {
    const result = rollDice(notation);
    return `Rolled ${notation}: ${result.total} (Details: ${result.details})`;
}

function rollDice(notation) {
    const dicePattern = /(\d*)d(\d+)([+-]\d+)?/g;
    let match;
    let total = 0;
    const details = [];
    while ((match = dicePattern.exec(notation)) !== null) {
        const count = Number.parseInt(match[1], 10) || 1;
        const sides = Number.parseInt(match[2], 10);
        const modifier = match[3] ? Number.parseInt(match[3], 10) : 0;
        let rollTotal = 0;
        const rolls = [];
        for (let index = 0; index < count; index += 1) {
            const roll = Math.floor(Math.random() * sides) + 1;
            rolls.push(roll);
            rollTotal += roll;
        }
        rollTotal += modifier;
        total += rollTotal;
        details.push(`${count}d${sides}${modifier ? match[3] : ''}: [${rolls.join(', ')}]${modifier ? ` ${match[3]}` : ''} = ${rollTotal}`);
    }
    return { total, details: details.join('; ') };
}

module.exports = {
    selectServerTools,
    executeToolCall,
};
