// Minimal VM test for the addPair function in this folder.
// Uses the compiled Main.vm and expected output Main.cmp.

load Main.vm,
compare-to Main.cmp,

set sp 256,
set local 300,
set argument 400,
set this 3000,
set that 4000,
set argument[0] 11,
set argument[1] 5,

repeat 5 {
  vmstep;
}

// Outputs the stack pointer and the first local slot (which stores the sum).
output-list RAM[0]%D1.6.1 RAM[300]%D1.6.1;
output;
