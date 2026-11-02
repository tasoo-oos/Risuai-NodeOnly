// Dependency-free so request-side code (model-job recovery) can escape a
// response the way requestChatData does without importing the parser module
// graph. parser.svelte.ts re-exports it; the private-use code points must stay
// in sync with risuUnescape's replacement table there.
export function risuEscape(text:string){
    return text.replace(/[{}()]/g, (f) => {
        switch(f){
            case '{': return '\uE9B8'
            case '}': return '\uE9B9'
            case '(': return '\uE9BA'
            case ')': return '\uE9BB'
            default: return f
        }
    })
}
