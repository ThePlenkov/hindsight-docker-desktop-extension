import { useState } from "react";
import { createDockerDesktopClient } from "@docker/extension-api-client";
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Container,
} from "@mui/material";
import StatusPanel from "./components/StatusPanel";
import ConfigPanel from "./components/ConfigPanel";
import MemoryBrowser from "./components/MemoryBrowser";
import ReflectPanel from "./components/ReflectPanel";

const ddClient = createDockerDesktopClient();

function TabPanel(props: {
  children: React.ReactNode;
  value: number;
  index: number;
}) {
  const { children, value, index } = props;
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ pt: 2 }}>{children}</Box>}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState(0);

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Box sx={{ mb: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography variant="h4" fontWeight="bold">
          Agent Memory
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Shared offline memory for AI agents via Hindsight
        </Typography>
      </Box>

      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Status" />
          <Tab label="Memory Banks" />
          <Tab label="Reflect" />
          <Tab label="Settings" />
        </Tabs>
      </Box>

      <TabPanel value={tab} index={0}>
        <StatusPanel ddClient={ddClient} />
      </TabPanel>
      <TabPanel value={tab} index={1}>
        <MemoryBrowser ddClient={ddClient} />
      </TabPanel>
      <TabPanel value={tab} index={2}>
        <ReflectPanel ddClient={ddClient} />
      </TabPanel>
      <TabPanel value={tab} index={3}>
        <ConfigPanel ddClient={ddClient} />
      </TabPanel>
    </Container>
  );
}
