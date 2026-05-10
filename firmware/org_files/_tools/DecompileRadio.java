// Ghidra PostScript: extract Heltec HT-M00 radio driver C-code.
// - Find functions referenced from string markers ("Radio 0/1" etc.)
// - Add explicit function addresses (SPI read/write, etc.)
// - Resolve vtable slots (read pointer from memory)
// - Follow callees up to a depth, decompile all collected functions.
// Usage: ... -postScript DecompileRadio.java <out.c>
// @category HelTec.HTM00
// @runtime Java

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.util.task.ConsoleTaskMonitor;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class DecompileRadio extends GhidraScript {

    private static final String[] NEEDLES = {
        "radio spi error reset Radio",
        "Radio 0", "Radio 1",
        "lora packet with unknown bandwidth",
        "WARNING: [down]", "ERROR: [up]",
        "Heltec HT-M00 firmware", "HT-M00",
        "PA_BOOST", "RFO", "PaSelect", "PA_DAC",
        "RegPaConfig", "RegPaDac", "RegOcp",
    };

    // Functions we want to decompile explicitly.
    // From iteration 2 the wrappers FUN_400e2440/2450 just delegate to:
    private static final long[] EXPLICIT_FUNC_ADDRS = {
        0x400e2440L, // SPI write wrapper
        0x400e2450L, // SPI read wrapper
        0x400e0e28L, // real SPI write (called from wrapper)
        0x400e0e3cL, // real SPI read
        0x400e229cL, // local select_radio used in init loop
        0x400e2070L, // helper called from init
        0x400e1de8L, // helper called from init
        0x400e20c8L, // helper called from init/reset
        0x400da548L, // called after radio reset
        0x400e32f4L, // pin reset helper
    };

    // Pointers/data we want to dump verbatim to see config tables / pin values.
    // Each entry: { address, byteCount, label }
    private static final Object[][] MEM_DUMPS = {
        {0x400d0d44L, 4,    "DAT_400d0d44   (ptr to radio_config[] table — base for selector arithmetic)"},
        {0x400d0d48L, 4,    "DAT_400d0d48   (pin var, used in reset)"},
        {0x400d0d90L, 4,    "DAT_400d0d90   (pin var, used in reset)"},
        {0x400d0d9cL, 4,    "DAT_400d0d9c   (pin var, used in init)"},
        {0x400d0bf8L, 4,    "DAT_400d0bf8   (ptr to gpio output reg?)"},
        {0x400d05dcL, 4,    "DAT_400d05dc   (current_radio idx)"},
        {0x400d0da4L, 4,    "PTR_DAT_400d0da4 (ptr to init_reg_table — 16 entries used in init loop)"},
        {0x400d0d98L, 4,    "PTR_FUN_400d0d98 (function pointer used in init)"},
        {0x400d0da8L, 4,    "PTR_FUN_400d0da8 (gpio_set_dir-like callback)"},
        {0x400d0dacL, 4,    "PTR_FUN_400d0dac (function pointer)"},
        {0x400d0da0L, 4,    "PTR_PTR_400d0da0 (passed to PTR_FUN_400d0dac)"},
        // The vtable in DROM at 0x3f405ec4
        {0x3f405ec4L, 0x80, "vtable @ 0x3f405ec4 (128 bytes — function pointers used as radio ops)"},
    };

    // Pointer-of-pointer entries we want to dereference from memory.
    // Each entry: { tableBaseAddr, slotOffset }
    // PTR_PTR_400d00dc: vtable referenced as puVar4 in FUN_400e036c.
    // 0x5c is the slot used as radio selector callback.
    private static final long[][] VTABLE_SLOTS = {
        {0x400d00dcL, 0x5c}, // radio selector
        {0x400d00dcL, 0x2c}, // reset()
        {0x400d00dcL, 0x00}, // init()
        {0x400d00dcL, 0x58}, // power-on?
    };

    private static final int MAX_CALLEE_DEPTH = 2;
    private static final int DECOMP_TIMEOUT_S = 60;

    private Program prog;
    private Memory mem;
    private Listing listing;
    private FunctionManager fm;
    private ReferenceManager rm;

    @Override
    protected void run() throws Exception {
        prog = currentProgram;
        mem = prog.getMemory();
        listing = prog.getListing();
        fm = prog.getFunctionManager();
        rm = prog.getReferenceManager();

        String[] args = getScriptArgs();
        String outPath = (args.length > 0) ? args[0] : "/tmp/combined.c";

        println("[*] program: " + prog.getName());
        println("[*] functions defined: " + fm.getFunctionCount());

        Set<Function> seeds = new HashSet<>();

        // 1) String-driven seed functions
        for (String needle : NEEDLES) {
            for (Address a : findStringAddrs(needle)) {
                ReferenceIterator refs = rm.getReferencesTo(a);
                while (refs.hasNext()) {
                    Function fn = fm.getFunctionContaining(refs.next().getFromAddress());
                    if (fn != null && seeds.add(fn)) {
                        println("    [seed-str " + needle + "] " + fn.getName() + " @ " + fn.getEntryPoint());
                    }
                }
            }
        }

        // 2) Explicit functions
        for (long addr : EXPLICIT_FUNC_ADDRS) {
            Address a = addr(addr);
            Function fn = fm.getFunctionAt(a);
            if (fn == null) fn = fm.getFunctionContaining(a);
            if (fn != null && seeds.add(fn)) {
                println("    [seed-explicit] " + fn.getName() + " @ " + fn.getEntryPoint());
            } else {
                println("    [seed-explicit] no function at " + a);
            }
        }

        // 2b) Find all functions that REFERENCE the radio_config_table pointer DAT_400d0d44
        //     (they read or write to the table — init paths included)
        Address tableSym = addr(0x400d0d44L);
        ReferenceIterator tableRefs = rm.getReferencesTo(tableSym);
        while (tableRefs.hasNext()) {
            Reference r = tableRefs.next();
            Function fn = fm.getFunctionContaining(r.getFromAddress());
            if (fn != null && seeds.add(fn)) {
                println("    [seed-cfgtbl] " + fn.getName() + " @ " + fn.getEntryPoint() + " refs DAT_400d0d44 from " + r.getFromAddress() + " (" + r.getReferenceType() + ")");
            }
        }
        // Same for the radio_select callback (anyone who reads PTR_DAT_400d0bf8)
        Address bf8Sym = addr(0x400d0bf8L);
        ReferenceIterator bf8Refs = rm.getReferencesTo(bf8Sym);
        while (bf8Refs.hasNext()) {
            Reference r = bf8Refs.next();
            Function fn = fm.getFunctionContaining(r.getFromAddress());
            if (fn != null && seeds.add(fn)) {
                println("    [seed-bf8] " + fn.getName() + " @ " + fn.getEntryPoint() + " refs DAT_400d0bf8 from " + r.getFromAddress());
            }
        }
        // Callers of the radio selector FUN_400e241c
        Function selectorFn = fm.getFunctionAt(addr(0x400e241cL));
        if (selectorFn != null) {
            for (Function caller : selectorFn.getCallingFunctions(monitor)) {
                if (seeds.add(caller)) {
                    println("    [seed-caller-of-selector] " + caller.getName() + " @ " + caller.getEntryPoint());
                }
            }
        }

        // 3) vtable slots: read pointer at (tableBase) [+ slotOffset], find function there
        for (long[] slot : VTABLE_SLOTS) {
            try {
                Address tablePtrAddr = addr(slot[0]);
                long tableBase = readUInt32LE(tablePtrAddr); // PTR_PTR_400d00dc holds a pointer to the table
                Address funcPtrAddr = addr(tableBase + slot[1]);
                long funcAddr = readUInt32LE(funcPtrAddr);
                Address fa = addr(funcAddr);
                Function fn = fm.getFunctionAt(fa);
                if (fn == null) fn = fm.getFunctionContaining(fa);
                println(String.format("    [vtable %08x+0x%x = base %08x, slot=%08x, func=%08x]",
                    slot[0], slot[1], tableBase, funcPtrAddr.getOffset(), funcAddr));
                if (fn != null && seeds.add(fn)) {
                    println("        -> " + fn.getName());
                }
            } catch (Exception e) {
                println("    [vtable error " + slot[0] + "+" + slot[1] + "]: " + e.getMessage());
            }
        }

        // 4) Expand by following callees
        Set<Function> all = new HashSet<>(seeds);
        Deque<Function> queue = new ArrayDeque<>();
        for (Function fn : seeds) queue.add(fn);
        java.util.Map<Function, Integer> depth = new java.util.HashMap<>();
        for (Function fn : seeds) depth.put(fn, 0);
        while (!queue.isEmpty()) {
            Function fn = queue.poll();
            int d = depth.get(fn);
            if (d >= MAX_CALLEE_DEPTH) continue;
            for (Function callee : fn.getCalledFunctions(monitor)) {
                if (callee.isThunk()) callee = callee.getThunkedFunction(true);
                if (callee == null) continue;
                if (callee.isExternal()) continue;
                if (all.add(callee)) {
                    depth.put(callee, d + 1);
                    queue.add(callee);
                }
            }
        }

        println("[*] seeds: " + seeds.size() + ", total with callees: " + all.size());

        // 5) Decompile all
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(prog);
        ConsoleTaskMonitor cmonitor = new ConsoleTaskMonitor();

        try (PrintWriter out = new PrintWriter(new FileWriter(new File(outPath)))) {
            out.println("// Decompile of " + prog.getName());
            out.println("// " + all.size() + " function(s) (" + seeds.size() + " seed + callees up to depth " + MAX_CALLEE_DEPTH + ")");
            out.println();

            // Memory dumps section
            out.println("// ============================================");
            out.println("// MEMORY DUMPS");
            out.println("// ============================================");
            for (Object[] entry : MEM_DUMPS) {
                long a = (Long) entry[0];
                int n = ((Integer) entry[1]).intValue();
                String label = (String) entry[2];
                try {
                    byte[] buf = new byte[n];
                    mem.getBytes(addr(a), buf);
                    out.print(String.format("// %s\n//   @ 0x%08x [%d bytes]: ", label, a, n));
                    StringBuilder hex = new StringBuilder();
                    for (int i = 0; i < buf.length; i++) {
                        if (i > 0 && i % 16 == 0) hex.append("\n//                          ");
                        hex.append(String.format("%02x ", buf[i] & 0xff));
                    }
                    out.println(hex.toString().trim());
                    if (n == 4) {
                        long val = ((long)(buf[0]&0xff)) | ((long)(buf[1]&0xff)<<8)
                                 | ((long)(buf[2]&0xff)<<16) | ((long)(buf[3]&0xff)<<24);
                        out.println(String.format("//   = 0x%08x (LE u32)", val));
                    }
                    out.println();
                } catch (Exception e) {
                    out.println(String.format("// %s: dump failed: %s", label, e.getMessage()));
                }
            }

            // Special: dereference DAT_400d0d44 to read the radio_config[] table.
            try {
                long tablePtr = readUInt32LE(addr(0x400d0d44L));
                out.println(String.format("// >> Following DAT_400d0d44 -> 0x%08x", tablePtr));
                int dumpLen = 2 * 0x3c; // 2 entries * 60 bytes
                byte[] buf = new byte[dumpLen];
                mem.getBytes(addr(tablePtr), buf);
                for (int radio = 0; radio < 2; radio++) {
                    out.println(String.format("//   radio_config[%d] @ 0x%08x:", radio, tablePtr + radio * 0x3c));
                    StringBuilder hex = new StringBuilder("//     ");
                    for (int i = 0; i < 0x3c; i++) {
                        int idx = radio * 0x3c + i;
                        if (i > 0 && i % 16 == 0) hex.append("\n//     ");
                        hex.append(String.format("%02x ", buf[idx] & 0xff));
                    }
                    out.println(hex.toString());
                    int off7 = buf[radio * 0x3c + 7] & 0xff;
                    int off8 = buf[radio * 0x3c + 8] & 0xff;
                    int off30 = buf[radio * 0x3c + 0x30] & 0xff;
                    out.println(String.format("//   -> field_07 = 0x%02x (NSS pin/mask?)", off7));
                    out.println(String.format("//   -> field_08 = 0x%02x", off8));
                    out.println(String.format("//   -> field_30 = 0x%02x", off30));
                }
                out.println();
            } catch (Exception e) {
                out.println("// radio_config dump failed: " + e.getMessage());
            }
            out.println();

            List<Function> sorted = new ArrayList<>(all);
            sorted.sort((x, y) -> Long.compare(
                x.getEntryPoint().getOffset(),
                y.getEntryPoint().getOffset()));

            int ok = 0, fail = 0;
            for (Function fn : sorted) {
                out.println("// ============================================");
                out.println("// " + fn.getName() + " @ " + fn.getEntryPoint()
                    + " (size=" + fn.getBody().getNumAddresses() + ")");
                out.println("//   signature: " + fn.getSignature().getPrototypeString());
                out.println("//   seed: " + (seeds.contains(fn) ? "yes" : "no"));
                out.println("// ============================================");
                try {
                    DecompileResults res = decomp.decompileFunction(fn, DECOMP_TIMEOUT_S, cmonitor);
                    if (res != null && res.decompileCompleted()) {
                        out.println(res.getDecompiledFunction().getC());
                        ok++;
                    } else {
                        out.println("// (decompile failed: "
                            + (res != null ? res.getErrorMessage() : "no result") + ")");
                        fail++;
                    }
                } catch (Exception e) {
                    out.println("// (exception: " + e.getMessage() + ")");
                    fail++;
                }
                out.println();
            }
            out.println("// Decompiled OK: " + ok + ", failed: " + fail);
            println("[*] decompiled OK: " + ok + ", failed: " + fail);
        }

        decomp.dispose();
        println("[*] wrote " + outPath);
    }

    private long readUInt32LE(Address a) throws Exception {
        byte[] b = new byte[4];
        mem.getBytes(a, b);
        return ((long)(b[0] & 0xff))
             | ((long)(b[1] & 0xff) << 8)
             | ((long)(b[2] & 0xff) << 16)
             | ((long)(b[3] & 0xff) << 24);
    }

    private Address addr(long off) {
        return prog.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private List<Address> findStringAddrs(String needle) throws Exception {
        List<Address> hits = new ArrayList<>();
        DataIterator di = listing.getDefinedData(true);
        while (di.hasNext()) {
            Data d = di.next();
            if (d.hasStringValue()) {
                Object v = d.getValue();
                if (v != null && v.toString().contains(needle)) hits.add(d.getAddress());
            }
        }
        if (!hits.isEmpty()) return hits;
        // fallback: raw byte search in non-exec memory
        byte[] needleBytes = needle.getBytes("US-ASCII");
        for (MemoryBlock b : mem.getBlocks()) {
            if (!b.isInitialized() || b.isExecute()) continue;
            long size = b.getSize();
            if (size > 8 * 1024 * 1024) continue;
            byte[] buf = new byte[(int) size];
            mem.getBytes(b.getStart(), buf);
            for (int i = 0; i + needleBytes.length <= buf.length; i++) {
                boolean ok = true;
                for (int j = 0; j < needleBytes.length; j++) {
                    if (buf[i + j] != needleBytes[j]) { ok = false; break; }
                }
                if (ok) {
                    hits.add(b.getStart().add(i));
                    i += needleBytes.length - 1;
                }
            }
        }
        return hits;
    }
}