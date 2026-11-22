export interface CommandFamily {
    id: string;
    priority: number;
    match: (ctx: any) => boolean;
    compress: (text: string, ctx?: any) => string;
}
import * as git from "./git.ts";
export declare const FAMILIES: readonly {
    id: string;
    priority: number;
    match: typeof git.match;
    compress: typeof git.compress;
}[];
