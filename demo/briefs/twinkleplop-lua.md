<!-- SPDX-License-Identifier: Apache-2.0 -->
# Lua support for twinkleplop (pngwn/twinkleplop#102)

This repository is twinkleplop, a regex-free syntax highlighter. Issue #102 asks for Lua: files `.lua`,
code fence `lua`, reference the Lua 5.4 manual. Add a `@twinkleplop/lua` language package that highlights
Lua 5.4 correctly, in the same shape and to the same standard as the existing languages. The work may be
proposed upstream to the maintainer, so match the repository's conventions exactly and keep the change to
what adding a language needs.

## How to work

Follow the repository's own agent skills, in order. They are the maintainer's process:

1. `.agents/skills/grammar-researcher/SKILL.md`: write `languages/lua/RESEARCH.md` (gitignored, so it is
   your working document, not part of the change). You have no Internet access except the npm registry.
   Your primary source is the Lua 5.4 Reference Manual excerpt at the end of this brief; cite its sections.
2. `.agents/skills/grammar-author/SKILL.md`: build the grammar phase by phase. Read `grammar.md` first.

Model the package on the most recent language additions (`languages/c`, `languages/dockerfile`):
`package.json` (version `0.0.0` is fine; the changeset sets the release), `tsconfig.json`, `src/grammar.ts`,
`src/grammar.test.ts`, `src/index.ts`, and `test/` fixtures (`*.lua`) with their generated
`*.output.js` snapshots (see `generate-snapshots.js` in those packages). Use the standard token names in
`lib/core/src/tokens.ts`.

Required behaviour. Each item needs its own fixture lines and a unit test that asserts the token types:

1. Long brackets of every level (`[[ ]]`, `[==[ ]==]`) as strings and as comments (`--[[ ]]`,
   `--[==[ ]==]`); a closing bracket of a different level inside does not end them.
2. Short strings with `string_escape` tokens for every escape, as `languages/python` does: `\a \b \f \n \r
   \t \v \\ \" \'`, a backslash before a newline, `\xXX`, `\ddd` (one to three digits), `\u{XXX}`, and
   `\z` together with the whitespace it skips. An escaped quote never ends the string.
3. Numerals: decimal and hexadecimal integers and floats, exponents (`e`/`E`, and `p`/`P` for hex), and a
   leading dot (`.5`, `.5e3`).
4. `...` (varargs) is one token on its own, never merged with a neighbouring `)` or `,`; `..` is concatenation.
5. Attributes in `local x <const> = 1` and `local f <close> = …`: the name is an `attribute` token.
6. Labels: in `::name::` and `goto name`, the name is a `label` token.
7. Function names: in `function name`, `local function name`, `function a.b.c` and `function a.b:c`, the
   defined name is a `function` token; method calls (`obj:method()`) and ordinary calls (`f()`) mark the
   called name as `function` too.
8. Every Lua 5.4 keyword and operator from the manual excerpt below (`//`, `~=`, `~`, `<<`, `>>`, `#`, `::`).

Document anything you deliberately do not handle in a known-limitations comment, in the format
`languages/html/src/grammar.ts` uses; none of the eight items above may be a limitation.

Register the language where the existing ones are registered, as the C and C++ addition did:
`lib/_site/package.json` (`"@twinkleplop/lua": "workspace:*"`), `lib/_site/src/lib/explore/grammars.ts`,
`lib/_site/src/lib/explore/shiki_client.ts`, a demo file `lib/_site/src/lib/explore/demos/lua.lua`, and an
entry in `lib/_site/src/routes/docs/languages-ref/+page.svelte`. Add a changeset
`.changeset/lua-grammar.md` marking `"@twinkleplop/lua": minor`, with one sentence describing what is
highlighted. Do not change other languages, the core library or the build.

## Commands (Node 24; pnpm 10 through npx)

```
npx --yes pnpm@10 install                       # after adding the package; commit pnpm-lock.yaml
npx --yes pnpm@10 --filter './lib/theme-*' build
npx --yes pnpm@10 --filter site exec svelte-kit sync
npx --yes pnpm@10 test                          # the whole suite must pass
npx --yes pnpm@10 --filter ./languages/lua exec vite build --config ../../build/language.vite.config.ts
npx --yes pnpm@10 --filter ./languages/lua run types
```

The platform tests your pushed commit in an isolated sandbox with `pnpm install --frozen-lockfile`, the
theme build, `svelte-kit sync` and `pnpm test`, so the committed lockfile must match. Every command above
passes on `main` today; there are no pre-existing failures, so a failure in your work is yours to fix.
Show a new test failing before your grammar handles its case, then passing.

Commit and `git push origin HEAD:main` each time a requirement works; your latest push is your candidate,
and your sandbox is discarded when you finish. Your run is not finished until your last `git push`
succeeds with the full suite passing.
Do not wait for another agent or call the platform control API.

## Rules

Work only in your own clone and lane. Use plain Git to push `HEAD:main` to `origin`; `upstream` is
read-only. Never force-push, merge, approve or close anything, or edit other agents' work. This is the
maintainer's MIT-licensed project: follow its style and file headers, and add no dependencies beyond the
workspace packages existing languages use. Never print, commit or paste tokens; credentials stay in local
Git headers. Report exact test output. If blocked, report the exact cause and push nothing broken.

## Closing message to your team

End your run with a short message for your teammates and the human who decides (3 to 5 sentences): your
approach, what you chose not to handle and why, and your exact test result. It is posted to this task's
discussion under your name, verbatim: start directly with the explanation, with no status lines such as
"Committed and pushed". Never include credentials, tokens or configuration.

## Primary source: Lua 5.4 Reference Manual (excerpt)

From the Lua 5.4 Reference Manual by R. Ierusalimschy, L. H. de Figueiredo and W. Celes,
https://www.lua.org/manual/5.4/manual.html. Copyright © 2020–2026 Lua.org, PUC-Rio. Freely available under
the terms of the Lua license.

#### §3.1 Lexical Conventions

Lua is a free-form language. It ignores spaces and comments between lexical elements (tokens), except as delimiters between two tokens. In source code, Lua recognizes as spaces the standard ASCII whitespace characters space, form feed, newline, carriage return, horizontal tab, and vertical tab.

Names (also called identifiers) in Lua can be any string of Latin letters, Arabic-Indic digits, and underscores, not beginning with a digit and not being a reserved word. Identifiers are used to name variables, table fields, and labels.

The following keywords are reserved and cannot be used as names:

```
     and       break     do        else      elseif    end
     false     for       function  goto      if        in
     local     nil       not       or        repeat    return
     then      true      until     while
```

Lua is a case-sensitive language: `and` is a reserved word, but `And` and `AND` are two different, valid names. As a convention, programs should avoid creating names that start with an underscore followed by one or more uppercase letters (such as `_VERSION`).

The following strings denote other tokens:

```
     +     -     *     /     %     ^     #
     &     ~     |     <<    >>    //
     ==    ~=    <=    >=    <     >     =
     (     )     {     }     [     ]     ::
     ;     :     ,     .     ..    ...
```

A short literal string can be delimited by matching single or double quotes, and can contain the following C-like escape sequences: '`\a`' (bell), '`\b`' (backspace), '`\f`' (form feed), '`\n`' (newline), '`\r`' (carriage return), '`\t`' (horizontal tab), '`\v`' (vertical tab), '`\\`' (backslash), '`\"`' (quotation mark [double quote]), and '`\'`' (apostrophe [single quote]). A backslash followed by a line break results in a newline in the string. The escape sequence '`\z`' skips the following span of whitespace characters, including line breaks; it is particularly useful to break and indent a long literal string into multiple lines without adding the newlines and spaces into the string contents. A short literal string cannot contain unescaped line breaks nor escapes not forming a valid escape sequence.

We can specify any byte in a short literal string, including embedded zeros, by its numeric value. This can be done with the escape sequence `\xXX`, where XX is a sequence of exactly two hexadecimal digits, or with the escape sequence `\ddd`, where ddd is a sequence of up to three decimal digits. (Note that if a decimal escape sequence is to be followed by a digit, it must be expressed using exactly three digits.)

The UTF-8 encoding of a Unicode character can be inserted in a literal string with the escape sequence `\u{XXX}` (with mandatory enclosing braces), where XXX is a sequence of one or more hexadecimal digits representing the character code point. This code point can be any value less than 231. (Lua uses the original UTF-8 specification here, which is not restricted to valid Unicode code points.)

Literal strings can also be defined using a long format enclosed by long brackets. We define an opening long bracket of level n as an opening square bracket followed by n equal signs followed by another opening square bracket. So, an opening long bracket of level 0 is written as `[[`, an opening long bracket of level 1 is written as `[=[`, and so on. A closing long bracket is defined similarly; for instance, a closing long bracket of level 4 is written as  `]====]`. A long literal starts with an opening long bracket of any level and ends at the first closing long bracket of the same level. It can contain any text except a closing bracket of the same level. Literals in this bracketed form can run for several lines, do not interpret any escape sequences, and ignore long brackets of any other level. Any kind of end-of-line sequence (carriage return, newline, carriage return followed by newline, or newline followed by carriage return) is converted to a simple newline. When the opening long bracket is immediately followed by a newline, the newline is not included in the string.

As an example, in a system using ASCII (in which '`a`' is coded as 97, newline is coded as 10, and '`1`' is coded as 49), the five literal strings below denote the same string:

```
     a = 'alo\n123"'
     a = "alo\n123\""
     a = '\97lo\10\04923"'
     a = [[alo
     123"]]
     a = [==[
     alo
     123"]==]
```

Any byte in a literal string not explicitly affected by the previous rules represents itself. However, Lua opens files for parsing in text mode, and the system's file functions may have problems with some control characters. So, it is safer to represent binary data as a quoted literal with explicit escape sequences for the non-text characters.

A numeric constant (or numeral) can be written with an optional fractional part and an optional decimal exponent, marked by a letter '`e`' or '`E`'. Lua also accepts hexadecimal constants, which start with `0x` or `0X`. Hexadecimal constants also accept an optional fractional part plus an optional binary exponent, marked by a letter '`p`' or '`P`' and written in decimal. (For instance, `0x1.fp10` denotes 1984, which is 0x1f / 16 multiplied by 210.)

A numeric constant with a radix point or an exponent denotes a float; otherwise, if its value fits in an integer or it is a hexadecimal constant, it denotes an integer; otherwise (that is, a decimal integer numeral that overflows), it denotes a float. Hexadecimal numerals with neither a radix point nor an exponent always denote an integer value; if the value overflows, it wraps around to fit into a valid integer.

Examples of valid integer constants are

```
     3   345   0xff   0xBEBADA
```

Examples of valid float constants are

```
     3.0     3.1416     314.16e-2     0.31416E1     34e1
     0x0.1E  0xA23p-4   0X1.921FB54442D18P+1
```

A comment starts with a double hyphen (`--`) anywhere outside a string. If the text immediately after `--` is not an opening long bracket, the comment is a short comment, which runs until the end of the line. Otherwise, it is a long comment, which runs until the corresponding closing long bracket.

#### §9 The Complete Syntax of Lua

Here is the complete syntax of Lua in extended BNF. As usual in extended BNF, {A} means 0 or more As, and [A] means an optional A. (For operator precedences, see §3.4.8; for a description of the terminals Name, Numeral, and LiteralString, see §3.1.)

```
	chunk ::= block

	block ::= {stat} [retstat]

	stat ::=  ‘;’ | 
		 varlist ‘=’ explist | 
		 functioncall | 
		 label | 
		 break | 
		 goto Name | 
		 do block end | 
		 while exp do block end | 
		 repeat block until exp | 
		 if exp then block {elseif exp then block} [else block] end | 
		 for Name ‘=’ exp ‘,’ exp [‘,’ exp] do block end | 
		 for namelist in explist do block end | 
		 function funcname funcbody | 
		 local function Name funcbody | 
		 local attnamelist [‘=’ explist] 

	attnamelist ::=  Name attrib {‘,’ Name attrib}

	attrib ::= [‘<’ Name ‘>’]

	retstat ::= return [explist] [‘;’]

	label ::= ‘::’ Name ‘::’

	funcname ::= Name {‘.’ Name} [‘:’ Name]

	varlist ::= var {‘,’ var}

	var ::=  Name | prefixexp ‘[’ exp ‘]’ | prefixexp ‘.’ Name 

	namelist ::= Name {‘,’ Name}

	explist ::= exp {‘,’ exp}

	exp ::=  nil | false | true | Numeral | LiteralString | ‘...’ | functiondef | 
		 prefixexp | tableconstructor | exp binop exp | unop exp 

	prefixexp ::= var | functioncall | ‘(’ exp ‘)’

	functioncall ::=  prefixexp args | prefixexp ‘:’ Name args 

	args ::=  ‘(’ [explist] ‘)’ | tableconstructor | LiteralString 

	functiondef ::= function funcbody

	funcbody ::= ‘(’ [parlist] ‘)’ block end

	parlist ::= namelist [‘,’ ‘...’] | ‘...’

	tableconstructor ::= ‘{’ [fieldlist] ‘}’

	fieldlist ::= field {fieldsep field} [fieldsep]

	field ::= ‘[’ exp ‘]’ ‘=’ exp | Name ‘=’ exp | exp

	fieldsep ::= ‘,’ | ‘;’

	binop ::=  ‘+’ | ‘-’ | ‘*’ | ‘/’ | ‘//’ | ‘^’ | ‘%’ | 
		 ‘&’ | ‘~’ | ‘|’ | ‘>>’ | ‘<<’ | ‘..’ | 
		 ‘<’ | ‘<=’ | ‘>’ | ‘>=’ | ‘==’ | ‘~=’ | 
		 and | or

	unop ::= ‘-’ | not | ‘#’ | ‘~’
```

Last update: Tue Aug 25 19:35:19 UTC 2026
