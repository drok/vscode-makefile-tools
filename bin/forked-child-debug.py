import pprint
import gdb

# This doesn't work because catchpoitns are not implemented - see BP_CATCHPOINT comment in gdb manpage
class ForkCatch(gdb.Breakpoint):
    def __init__(self):
        super(ForkCatch, self).__init__("fork", internal=True)
        self.silent = True
        self.isForkBP = False

    def stop(self):
        print("Fork catchpoint hit. ......................")
        # self.isForkBP = True
        # child_pid = gdb.selected_inferior().pid
        # # print_inferiors()
        # lastinf = gdb.inferiors()[-1]
        # print("Stopped PID:", child_pid)
        # print("Child PID:", lastinf.pid)
        # pprint.pprint(lastinf)
        # inferior_handler.sub_gdb()
        # print(f"  Inferior {inferior.num}:")
        return True # stop exec  # Continue execution after printing the inferiors

#    def stopped(self, event):
#        if self.isForkBP == True:
#          if isinstance(event, gdb.BreakpointEvent):
#            print("Stop handler running - for Fork BP")
#            gdb.execute("step")
#          elif isinstance(event, gdb.StopEvent):
#            print("Stop handler running - for Fork STOP")
#            self.isForkBP=False
#            print(f"Stop handler running - for Fork STOP {self.isForkBP}")
#            inferior_handler.sub_gdb()
#            # gdb.execute("step") # nothing past this executes
#            # gdb.execute("cont") # nothing past this executes
#          else:
#            pprint.pprint(event)
#            print("Stop handler running - for Unk event")
#        else:
#          print("Stop handler running - for STOP")

class InferiorHandler:
    def __init__(self):
        self.inferior_created = False
        self.new_inferior_event = gdb.events.new_inferior
        self.new_inferior_event.connect(self.handle_inferior_creation)
        # self.inferior_num = 0
        self.inferior = None

    def handle_inferior_creation(self, event):
        print("Handle Inferior Creation --------- child PID = %s" % event.inferior.pid)
        # py3 print(f"Handle Inferior Creation --------- child PID = {event.inferior.pid}")
        if event.inferior:
            # Get the newly created inferior
            self.inferior = event.inferior
            # self.inferior_num = self.inferior.num
            self.inferior_created = True

    def sub_gdb(self):
        if self.inferior:
          # gdb.execute("step")
          gdb.execute("inferior %d" % self.inferior.num)
#          gdb.execute("queue-signal SIGSTOP")
#          disable_yama()
          childpid = self.inferior.pid
#          gdb.execute("detach inferior %d" % self.inferior.num)
#          gdb.execute("inferior 1")
#          gdb.execute("interrupt")
          gdb.execute("inferior 1")
#          self.start_child_gdb(childpid)
          self.inferior = None

    def start_child_gdb(self, childpid):
          gdb.execute("set detach-on-fork on")
          gdb.execute("call system(\"gdb -ex=continue -ex=quit -p %d\")" % childpid)
          gdb.execute("set detach-on-fork off")

    def breakpoint(self, event):
        print("Stop handler running - for Fork BP")
        # gdb.execute("info inferiors")
        gdb.write('=ZZZZZZZZZZZZZZ,arg="1"', gdb.STDOUT)
        gdb.execute("step")
        gdb.execute("info inferiors")
        gdb.execute("inferior 1")

    def stopped(self, event):
        if (self.inferior):
          print("Stop handler running - for Fork STOP")
          self.isForkBP=False
          # print(f"Stop handler running - for Fork STOP {self.isForkBP}")
          inferior_handler.sub_gdb()
          # gdb.execute("step") # nothing past this executes
          gdb.execute("cont") # nothing past this executes


#def disable_yama():
    # Disable for child process
    # https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2d514487faf188938a4ee4fb3464eeecfbdcf8eb
    # gdb.execute("call prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0,0,0)") 
    # gdb.execute("call (int)prctl(0x59616d61, ((unsigned long)-1), 0,0,0)") 

def has_catchpoint_breakpoint(breakpoints):
    for breakpoint in breakpoints:
        if breakpoint.type == gdb.BP_CATCHPOINT:
            return True
    return False

captureFirstStop = True
def stop_handler(event):
    global captureFirstStop
    # When a fork event is triggered
    print("STOP handler running.")
    if isinstance(event, gdb.BreakpointEvent):
      print("STOP handler: bp")
      if (has_catchpoint_breakpoint(event.breakpoints)):
        inferior_handler.breakpoint(event)
    elif isinstance(event, gdb.SignalEvent):
      print("STOP handler: signal")
      # print("SignalEvent = {event.stop_signal} - capt {captureFirstStop}.")
      if (event.stop_signal == "SIGSTOP"):
         captureFirstStop = False
         gdb.execute("cont")
    elif isinstance(event, gdb.StopEvent):
      print("STOP handler: stop")
      inferior_handler.stopped(event)

def stop_handler_no_catchpoints(event):
    global captureFirstStop
    # When a fork event is triggered
    print("STOP handler running.")
    if isinstance(event, gdb.BreakpointEvent):
      print("STOP handler: bp")
    #  if hasattr(gdb, 'BP_CATCHPOINT'):
    #    if (has_catchpoint_breakpoint(event.breakpoints)):
    #      inferior_handler.breakpoint(event)
    elif isinstance(event, gdb.SignalEvent):
      print("STOP handler: signal")
      # print("SignalEvent = {event.stop_signal} - capt {captureFirstStop}.")
      if (event.stop_signal == "SIGSTOP"):
         captureFirstStop = False
         gdb.execute("cont")
    elif isinstance(event, gdb.StopEvent):
      print("STOP handler: stop")
      #pprint.pprint(event)
      # dump(event)
      #pprint.pprint(vars(event))
      # print(event)
      #if hasattr(event, 'breakpoint'):
        # pprint.pprint(event.breakpoint)
        # dump(event.breakpoint)
      # data = {"id": 444, "type": "zz"}
      # gdb.notify_mi("-ZZZZZZZZZZZZZZ", data)
      a = gdb.current_progspace()
      dump(a)
      frame = gdb.newest_frame()
      if frame.is_valid():
        fn = frame.function()
        if fn.is_valid() and fn.linkage_name == '__libc_fork':
          # dump(frame)
          # dump(frame.function())
          # dump(frame.type())
      # pprint.pprint(vars(event.breakpoint))
      #if hasattr(event, 'breakpoints'):
      #  pprint.pprint(vars(event.breakpoints))
      #  pprint.pprint(vars(event.breakpoints[0]))
      # if (event.breakpoint == fork_catch):
#      if event.inferior_thread is None:
          # gdb.execute("set schedule-multiple off")
          # gdb.execute("info inferiors")
          inferior_handler.breakpoint(event)
          inferior_handler.sub_gdb()
          # gdb.execute("info inferiors")
          # gdb.execute("set schedule-multiple on")

#      else:
#        inferior_handler.stopped(event)

def breakpoint_created(event):
    print("Breakpoint created ===========================")
    dump(event)

def dump(obj):
  for attr in dir(obj):
    print("obj.%s = %r" % (attr, getattr(obj, attr)))

# gdb.execute("set dap-log-file /tmp/gdb.dap.log")
# gdb.execute("set dap-log-level 2")
# gdset schedule-multiple
gdb.execute("set schedule-multiple on")
gdb.execute("set print inferior-events on")
# gdb.set_parameter("print inferior-events", "on")
gdb.execute("set detach-on-fork off")
gdb.execute("set follow-fork-mode parent")
gdb.execute("set trace-commands off")

# Debug GDB's inner workings - not supported GBD 8.2?
# gdb.execute("set debug event on")
# gdb.execute("set debug infrun on")
# gdb.execute("set debug infcall on")
# gdb.execute("set debug target on")


# not needed??  # Set up the fork catchpoint
# not needed??  
# not needed??  # fork_catch = ForkCatch(gdb.breakpoints()[-1])
# not needed??  
# not needed??  # Test custom event
# not needed??  # print("=ZZZZZZZZZZZZZZ,arg=444")
# not needed??  
# not needed??  # Instantiate the InferiorHandler to handle inferior creation events
# not needed??  inferior_handler = InferiorHandler()
# not needed??  
# not needed??  # fork_catch = ForkCatch()
# not needed??  
# not needed??  # Register the fork_catch_handler to handle fork events
# not needed??  if hasattr(gdb, 'BP_CATCHPOINT'):
# not needed??      gdb.events.stop.connect(stop_handler)
# not needed??  else:
# not needed??      gdb.events.stop.connect(stop_handler_no_catchpoints)
# not needed??  
# not needed??  # gdb.events.breakpoint_created.connect(breakpoint_created)
# not needed??  gdb.execute("catch fork")
# not needed??  # fork_catch = gdb.breakpoints()[-1]
# not needed??  # dump(fork_catch)
# not needed??  # fork_catch.visible = False
# not needed??  # dump(fork_catch)
