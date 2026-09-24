--
-- PostgreSQL database dump
--

\restrict c7Zsu63HqPHwjvIiis6VEZk5Hha3HV7kUdzsCdu5EQilixydoeW1dlJ6IXB6i02

-- Dumped from database version 15.16 (Debian 15.16-0+deb12u1)
-- Dumped by pg_dump version 15.16 (Debian 15.16-0+deb12u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_states (
    agent_id text NOT NULL,
    state text NOT NULL,
    task_id text,
    step_id text,
    station_id text NOT NULL,
    last_message text,
    mood text DEFAULT 'CALM'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id text NOT NULL,
    task_id text NOT NULL,
    step_id text NOT NULL,
    agent_id text NOT NULL,
    tool_id text NOT NULL,
    action jsonb NOT NULL,
    risk text NOT NULL,
    parameters_hash text NOT NULL,
    reason text NOT NULL,
    target text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    decision text,
    scope text,
    note text,
    token_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone
);


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id text NOT NULL,
    task_id text NOT NULL,
    step_id text,
    agent_id text,
    kind text NOT NULL,
    name text NOT NULL,
    rel_path text NOT NULL,
    mime text DEFAULT 'application/octet-stream'::text NOT NULL,
    size integer DEFAULT 0 NOT NULL,
    meta jsonb,
    validated boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostics (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    report jsonb NOT NULL,
    duration_ms numeric DEFAULT '0'::numeric NOT NULL
);


--
-- Name: diagnostics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.diagnostics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: diagnostics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.diagnostics_id_seq OWNED BY public.diagnostics.id;


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    task_id text,
    run_id text,
    agent_id text,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb,
    severity text DEFAULT 'info'::text NOT NULL
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: plan_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_steps (
    id text NOT NULL,
    task_id text NOT NULL,
    step_index integer NOT NULL,
    title text NOT NULL,
    detail text,
    agent_id text NOT NULL,
    tool_id text,
    tool_input jsonb,
    risk text DEFAULT 'LOW'::text NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    approval_id text,
    walk_ms integer DEFAULT 1200 NOT NULL,
    output jsonb,
    error text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


--
-- Name: security_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_log (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    event text NOT NULL,
    tool_id text,
    task_id text,
    allowed boolean NOT NULL,
    detail text,
    data jsonb
);


--
-- Name: security_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_log_id_seq OWNED BY public.security_log.id;


--
-- Name: system_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_log (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    channel text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    task_id text,
    message text NOT NULL,
    data jsonb
);


--
-- Name: system_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_log_id_seq OWNED BY public.system_log.id;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id text NOT NULL,
    run_id text NOT NULL,
    title text NOT NULL,
    request jsonb NOT NULL,
    intent text NOT NULL,
    planner_engine text NOT NULL,
    status text DEFAULT 'QUEUED'::text NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    current_agent_id text,
    current_step_id text,
    work_dir text NOT NULL,
    summary text,
    final_answer text,
    error text,
    control_flag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);


--
-- Name: uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uploads (
    id text NOT NULL,
    task_id text,
    original_name text NOT NULL,
    safe_name text NOT NULL,
    rel_path text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    sha256 text NOT NULL,
    status text DEFAULT 'RECEIVED'::text NOT NULL,
    extraction jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: diagnostics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostics ALTER COLUMN id SET DEFAULT nextval('public.diagnostics_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: security_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_log ALTER COLUMN id SET DEFAULT nextval('public.security_log_id_seq'::regclass);


--
-- Name: system_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_log ALTER COLUMN id SET DEFAULT nextval('public.system_log_id_seq'::regclass);


--
-- Name: agent_states agent_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_states
    ADD CONSTRAINT agent_states_pkey PRIMARY KEY (agent_id);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);


--
-- Name: diagnostics diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostics
    ADD CONSTRAINT diagnostics_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: plan_steps plan_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_steps
    ADD CONSTRAINT plan_steps_pkey PRIMARY KEY (id);


--
-- Name: security_log security_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_log
    ADD CONSTRAINT security_log_pkey PRIMARY KEY (id);


--
-- Name: system_log system_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_log
    ADD CONSTRAINT system_log_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: uploads uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uploads
    ADD CONSTRAINT uploads_pkey PRIMARY KEY (id);


--
-- Name: approvals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_status_idx ON public.approvals USING btree (status, created_at);


--
-- Name: artifacts_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_task_idx ON public.artifacts USING btree (task_id);


--
-- Name: events_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_task_idx ON public.events USING btree (task_id, id);


--
-- Name: plan_steps_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plan_steps_task_idx ON public.plan_steps USING btree (task_id, step_index);


--
-- Name: tasks_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_created_idx ON public.tasks USING btree (created_at);


--
-- PostgreSQL database dump complete
--

\unrestrict c7Zsu63HqPHwjvIiis6VEZk5Hha3HV7kUdzsCdu5EQilixydoeW1dlJ6IXB6i02

